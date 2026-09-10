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

// el paquete real de la app Android (applicationId en build.gradle) - rechaza publicar el apk de
// otra app por error, no solo confiar en que quien sube el archivo se equivoco de ventana
const EXPECTED_PACKAGE = 'com.gagagps.operator';

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

  // dispara una revision inmediata en la(s) tableta(s) conectada(s) ahora mismo (socket) - sin
  // deviceId, a todas; con deviceId, solo a esa. Una tableta apagada/sin socket conectado en este
  // momento no lo recibe - se pone al dia en su siguiente revision programada (2 AM) o al arrancar
  router.post('/force-update', authMiddleware, canManage, (req, res) => {
    const { deviceId } = req.body as { deviceId?: string };
    if (deviceId) {
      socketServer.sendToDevice(deviceId, 'device:force_update', {});
    } else {
      socketServer.broadcast('device:force_update', {});
    }
    res.json({ success: true });
  });

  return router;
}

export default buildAppUpdateRouter;
