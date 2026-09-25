import type { RequestHandler } from 'express';
import ApkParser from 'app-info-parser/src/apk';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import fsPromises from 'fs/promises';
import multer from 'multer';
import path from 'path';
import { env } from '../../config';
import type AppReleaseRepository from '../../repositories/AppReleaseRepository';
import type DeviceRepository from '../../repositories/DeviceRepository';
import { isValidSharedSecret } from '../../utils/sharedSecret';
import { sendForceUpdatePush } from '../../services/push/FirebasePushService';

// el paquete real de la app Android (applicationId en build.gradle) - rechaza publicar el apk de
// otra app por error, no solo confiar en que quien sube el archivo se equivoco de ventana
const EXPECTED_PACKAGE = 'com.gaga.app';
// ComponentName#flattenToString() completo - el aprovisionamiento QR de Android (leido por el
// propio sistema operativo durante el setup de fabrica, no por esta app) necesita el nombre de
// clase completo, a diferencia de `adb shell dpm set-device-owner` que acepta el atajo ".kiosk...."
const ADMIN_COMPONENT = 'com.gaga.app/com.gaga.app.kiosk.KioskAdminReceiver';
// SHA-256 (base64url) del certificado con el que se firma el APK release - fijo mientras se siga
// usando el mismo keystore, no cambia entre versiones (a diferencia de PACKAGE_CHECKSUM, que hashea
// el archivo completo y hay que recalcular en cada release). Bug real de campo que motivo el
// cambio: el primer intento de aprovisionamiento QR fallo con el APK debug-signed (keystore de
// Android Studio, se regenera solo si se reinstala el IDE) - con PACKAGE_CHECKSUM cualquier
// diferencia de bytes en la descarga real tambien pudo haber sido la causa, nunca se aislo cual de
// las dos. SIGNATURE_CHECKSUM es la via que Google documenta como mas confiable para QR/NFC.
// Recalcular este valor (ver README) SOLO si algun dia se pierde o se rota el keystore de release -
// mientras tanto, publicar una version nueva no requiere tocar esto.
const RELEASE_SIGNATURE_CHECKSUM = 'h7bbahhRQK8yLPje8L0JjLOUhhglrt-D9-Ag6tnUG4w';

interface SocketServerLike {
  broadcast(event: string, payload: unknown): void;
  sendToDevice(deviceId: string, event: string, payload: unknown): void;
}

export interface AppUpdateRouterDeps {
  releasesDir: string;
  appReleaseRepo: AppReleaseRepository;
  deviceRepo: DeviceRepository;
  socketServer: SocketServerLike;
  authMiddleware: RequestHandler;
  requireRole: (...roles: string[]) => RequestHandler;
}

function apkPathFor(releasesDir: string, versionCode: number): string {
  return path.join(releasesDir, `${versionCode}.apk`);
}

// distribuye el APK de la app Android a las tabletas sin pasar por Play Store - clave compartida
// en las rutas que consume el dispositivo (mismo criterio que /gps, no hay sesion de usuario
// garantizada en ese momento), JWT de admin solo para publicar un release o forzar una revision
export function buildAppUpdateRouter({
  releasesDir,
  appReleaseRepo,
  deviceRepo,
  socketServer,
  authMiddleware,
  requireRole,
}: AppUpdateRouterDeps) {
  const router = express.Router();
  const uploadTmpDir = path.join(releasesDir, 'tmp-uploads');
  const canManage = requireRole('admin');

  fs.mkdirSync(uploadTmpDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadTmpDir),
      filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}.apk`),
    }),
    limits: { fileSize: env.maxApkUploadMb * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (path.extname(file.originalname).toLowerCase() !== '.apk') {
        return cb(new Error('Solo se aceptan archivos .apk'));
      }
      cb(null, true);
    },
  });

  router.get('/latest', async (req, res) => {
    if (!isValidSharedSecret(env.telemetrySharedSecret, req.query.key)) {
      return res.status(401).json({ error: 'Clave inválida' });
    }
    const latest = await appReleaseRepo.findLatest();
    if (!latest) return res.status(404).json({ error: 'Sin release publicado todavía' });
    res.json({
      versionCode: latest.version_code,
      versionName: latest.version_name,
      sha256: latest.sha256,
      sizeBytes: latest.size_bytes,
      releasedAt: latest.released_at,
    });
  });

  // credenciales NTRIP de fabrica, para que la tableta las pida en vivo desde u-center ("Obtener
  // del servidor") en vez de traerlas hardcodeadas en el APK - decompilar un .apk es trivial,
  // decompilar esto no expone nada porque nunca sale del backend salvo con la clave compartida
  // correcta. Clave compartida, mismo criterio que /latest. Config real en env.ntripDefault
  // (system_settings via loadSettingsOverrides, .env solo como semilla del primer arranque).
  router.get('/ntrip-config', async (req, res) => {
    if (!isValidSharedSecret(env.telemetrySharedSecret, req.query.key)) {
      return res.status(401).json({ error: 'Clave inválida' });
    }
    res.json({
      name: env.ntripDefault.name,
      host: env.ntripDefault.host,
      port: env.ntripDefault.port,
      username: env.ntripDefault.username,
      password: env.ntripDefault.password,
      mountpoint: env.ntripDefault.mountpoint,
      version: env.ntripDefault.version,
    });
  });

  router.get('/download', async (req, res) => {
    if (!isValidSharedSecret(env.telemetrySharedSecret, req.query.key)) {
      return res.status(401).json({ error: 'Clave inválida' });
    }
    const latest = await appReleaseRepo.findLatest();
    if (!latest) return res.status(404).json({ error: 'Sin release publicado todavía' });
    const apkPath = apkPathFor(releasesDir, latest.version_code);
    if (!fs.existsSync(apkPath)) return res.status(404).json({ error: 'Archivo del release no encontrado' });
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.sendFile(apkPath);
  });

  // reporte periodico de que version tiene instalada cada tableta (ver AppUpdateManager.kt) -
  // clave compartida, mismo criterio que el resto de este router. No crea el dispositivo si no
  // existe todavia (mismo criterio que /api/equipment-variables, no que /gps)
  router.post('/report-version', async (req, res) => {
    const { deviceId, versionCode, versionName, key } = req.body;
    if (!isValidSharedSecret(env.telemetrySharedSecret, key)) {
      return res.status(401).json({ error: 'Clave inválida' });
    }
    if (!deviceId || versionCode === undefined || !versionName) {
      return res.status(400).json({ error: 'deviceId, versionCode y versionName son requeridos' });
    }
    try {
      const updated = await deviceRepo.mergeAttributes(String(deviceId), {
        installedAppVersionCode: Number(versionCode),
        installedAppVersionName: String(versionName),
        installedAppReportedAt: new Date().toISOString(),
      });
      if (!updated) return res.status(404).json({ error: 'Dispositivo no encontrado' });
      res.json({ success: true });
    } catch (err) {
      console.error('app-update.routes POST /report-version:', (err as Error).message);
      res.status(500).json({ error: 'Error guardando la version reportada' });
    }
  });

  // token de Firebase Cloud Messaging de esta tableta (ver FCMService.kt, todavia sin activar del
  // lado nativo hasta tener google-services.json - ver README) - clave compartida, mismo criterio
  // que /report-version. Se guarda para poder mandarle una señal instantanea de "actualiza ahora"
  // sin depender del socket (que solo existe con el mapa abierto en pantalla)
  router.post('/fcm-token', async (req, res) => {
    const { deviceId, token, key } = req.body;
    if (!isValidSharedSecret(env.telemetrySharedSecret, key)) {
      return res.status(401).json({ error: 'Clave inválida' });
    }
    if (!deviceId || !token) {
      return res.status(400).json({ error: 'deviceId y token son requeridos' });
    }
    try {
      const updated = await deviceRepo.mergeAttributes(String(deviceId), { fcmToken: String(token) });
      if (!updated) return res.status(404).json({ error: 'Dispositivo no encontrado' });
      res.json({ success: true });
    } catch (err) {
      console.error('app-update.routes POST /fcm-token:', (err as Error).message);
      res.status(500).json({ error: 'Error guardando el token' });
    }
  });

  // payload para el QR de aprovisionamiento de fabrica (Device Owner sin adb, ver README) - lo
  // arma el backend porque necesita el sha256 del ultimo release (ya calculado al publicar) y el
  // telemetrySharedSecret (el mismo "token" que ya usan las tabletas, admin ya puede verlo tal
  // cual en GET /api/settings - esto no expone nada que un admin no viera ya). El sistema
  // operativo de la tableta lee este JSON directo del QR durante el setup de fabrica - nunca pasa
  // por nuestra app ni por este backend en ese momento, solo descarga el APK de `downloadUrl`.
  // misma logica de protocolo/clave que /qr-provisioning (ver comentario ahi abajo) - factorizada
  // porque ahora dos rutas la necesitan igual (el QR de aprovisionamiento y el QR de descarga simple)
  function buildDownloadUrl(req: express.Request): string {
    const forwardedProto = req.get('x-forwarded-proto');
    const protocol = forwardedProto ? forwardedProto.split(',')[0].trim() : req.protocol;
    return `${protocol}://${req.get('host')}/api/app/download?key=${encodeURIComponent(env.telemetrySharedSecret ?? '')}`;
  }

  // QR "de descarga" simple - no aprovisiona nada, solo abre la URL de /download en el navegador
  // al escanearlo con cualquier lector de QR normal (util para instalar/actualizar el APK a mano en
  // una tableta que ya tiene Device Owner via adb, sin teclear la URL en la pantalla de la tableta)
  router.get('/download-qr', authMiddleware, canManage, async (req, res) => {
    try {
      const latest = await appReleaseRepo.findLatest();
      if (!latest) return res.status(404).json({ error: 'Sin release publicado todavía' });
      if (!env.telemetrySharedSecret) {
        return res.status(400).json({ error: 'Configura el telemetry shared secret antes de generar el QR' });
      }

      res.json({
        versionCode: latest.version_code,
        versionName: latest.version_name,
        downloadUrl: buildDownloadUrl(req),
      });
    } catch (err) {
      console.error('app-update.routes GET /download-qr:', (err as Error).message);
      res.status(500).json({ error: 'Error generando el QR de descarga' });
    }
  });

  router.get('/qr-provisioning', authMiddleware, canManage, async (req, res) => {
    try {
      const latest = await appReleaseRepo.findLatest();
      if (!latest) return res.status(404).json({ error: 'Sin release publicado todavía' });
      if (!env.telemetrySharedSecret) {
        return res.status(400).json({ error: 'Configura el telemetry shared secret antes de generar el QR' });
      }

      // req.protocol siempre reporta 'http' detras de Caddy (el backend nunca ve TLS directo, ver
      // docker-compose.yml) - sin esto el QR traería una URL http:// real que el aprovisionamiento
      // de Android probablemente rechace. No se toca `app.set('trust proxy', ...)` globalmente
      // (afectaría req.ip del rate limiter) - solo se lee el header aquí, con fallback seguro.
      const downloadUrl = buildDownloadUrl(req);

      res.json({
        versionCode: latest.version_code,
        versionName: latest.version_name,
        provisioningPayload: {
          'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': ADMIN_COMPONENT,
          'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': downloadUrl,
          'android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM': RELEASE_SIGNATURE_CHECKSUM,
          'android.app.extra.PROVISIONING_SKIP_ENCRYPTION': true,
          'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': true,
        },
      });
    } catch (err) {
      console.error('app-update.routes GET /qr-provisioning:', (err as Error).message);
      res.status(500).json({ error: 'Error generando el aprovisionamiento QR' });
    }
  });

  router.get('/releases', authMiddleware, canManage, async (req, res) => {
    try {
      const releases = await appReleaseRepo.findAll();
      res.json(releases);
    } catch (err) {
      console.error('app-update.routes GET /releases:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo el historial de releases' });
    }
  });

  // version publicada mas reciente - autenticado (cualquier rol), sin exponer el historial
  // completo, solo para poder mostrar "actualizado/desactualizado" en el detalle de un vehiculo
  router.get('/version-info', authMiddleware, async (req, res) => {
    try {
      const latest = await appReleaseRepo.findLatest();
      if (!latest) return res.json({ versionCode: null, versionName: null });
      res.json({ versionCode: latest.version_code, versionName: latest.version_name });
    } catch (err) {
      console.error('app-update.routes GET /version-info:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo la version publicada' });
    }
  });

  // versionCode/versionName se leen del propio APK (AndroidManifest.xml), no de lo que quien
  // publica escriba a mano - una sola fuente de verdad, sin riesgo de que alguien no sepa cual
  // era la ultima version o suba un numero menor por error
  router.post('/release', authMiddleware, canManage, upload.single('apk'), async (req, res) => {
    const file = req.file;
    try {
      if (!file) return res.status(400).json({ error: 'apk es requerido' });

      const manifest = await new ApkParser(file.path).parse().catch(() => null);
      if (!manifest || manifest.versionCode === undefined || !manifest.versionName) {
        return res
          .status(400)
          .json({ error: 'No se pudo leer versionCode/versionName del APK - ¿es un .apk valido?' });
      }
      if (manifest.package && manifest.package !== EXPECTED_PACKAGE) {
        return res
          .status(400)
          .json({ error: `El APK es del paquete "${manifest.package}", se esperaba "${EXPECTED_PACKAGE}"` });
      }

      const versionCode = Number(manifest.versionCode);
      const versionName = String(manifest.versionName);

      const latest = await appReleaseRepo.findLatest();
      if (latest && versionCode <= latest.version_code) {
        return res.status(409).json({
          error: `El versionCode de este APK (${versionCode}) no es mayor al ya publicado (${latest.version_code}) - sube el build de Android Studio con el versionCode subido en build.gradle`,
        });
      }

      const buffer = await fsPromises.readFile(file.path);
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

      await fsPromises.rename(file.path, apkPathFor(releasesDir, versionCode));
      const release = await appReleaseRepo.create({
        versionCode,
        versionName,
        sha256,
        sizeBytes: buffer.length,
        releasedBy: req.user?.id ?? null,
      });

      res.status(201).json(release);
    } catch (err) {
      console.error('app-update.routes POST /release:', (err as Error).message);
      if ((err as { code?: string }).code === '23505') {
        return res.status(409).json({ error: 'Ya existe un release publicado con ese versionCode' });
      }
      res.status(500).json({ error: 'Error publicando el release' });
    } finally {
      // sigue existiendo si se rechazo antes del rename (apk invalido, paquete equivocado,
      // versionCode no mayor, error a medio camino) - un rename exitoso ya lo dejo sin nada que borrar
      if (file) await fsPromises.rm(file.path, { force: true }).catch(() => {});
    }
  });

  // dispara una revision inmediata en la(s) tableta(s) - dos canales independientes, cada uno
  // cubre lo que el otro no puede: el socket (instantaneo, pero solo llega si el operador tiene
  // la app abierta en el mapa con sesion iniciada) y el push de FCM (llega sin importar
  // pantalla/sesion, incluso con la app cerrada - no-op silencioso si FIREBASE_SERVICE_ACCOUNT_JSON
  // no esta configurado, ver FirebasePushService.ts). Sin deviceId, a todas; con deviceId, solo a esa.
  router.post('/force-update', authMiddleware, canManage, async (req, res) => {
    const { deviceId } = req.body as { deviceId?: string };
    if (deviceId) {
      socketServer.sendToDevice(deviceId, 'device:force_update', {});
      const device = await deviceRepo.findByUniqueId(deviceId);
      const token = device?.attributes.fcmToken;
      if (typeof token === 'string') await sendForceUpdatePush([token]);
    } else {
      socketServer.broadcast('device:force_update', {});
      const devices = await deviceRepo.findAll();
      const tokens = devices
        .map((d) => d.attributes.fcmToken)
        .filter((t): t is string => typeof t === 'string');
      await sendForceUpdatePush(tokens);
    }
    res.json({ success: true });
  });

  return router;
}

export default buildAppUpdateRouter;
