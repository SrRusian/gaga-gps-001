import type { RequestHandler } from 'express';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import fsPromises from 'fs/promises';
import multer from 'multer';
import path from 'path';
import { env } from '../../config';
import { isValidSharedSecret } from '../../utils/sharedSecret';

interface ReleaseManifest {
  versionCode: number;
  versionName: string;
  sha256: string;
  sizeBytes: number;
  releasedAt: string;
}

export interface AppUpdateRouterDeps {
  releasesDir: string;
  authMiddleware: RequestHandler;
  requireRole: (...roles: string[]) => RequestHandler;
}

// distribuye el APK de la app Android a las tabletas sin pasar por Play Store - clave compartida
// en las rutas que consume el dispositivo (mismo criterio que /gps, no hay sesion de usuario
// garantizada en ese momento), JWT de admin solo para subir un release nuevo
export function buildAppUpdateRouter({ releasesDir, authMiddleware, requireRole }: AppUpdateRouterDeps) {
  const router = express.Router();
  const manifestPath = path.join(releasesDir, 'manifest.json');
  const apkPath = path.join(releasesDir, 'app.apk');
  const uploadTmpDir = path.join(releasesDir, 'tmp-uploads');

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

  function readManifest(): ReleaseManifest | null {
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  router.get('/latest', (req, res) => {
    if (!isValidSharedSecret(env.telemetrySharedSecret, req.query.key)) {
      return res.status(401).json({ error: 'Clave inválida' });
    }
    const manifest = readManifest();
    if (!manifest) return res.status(404).json({ error: 'Sin release publicado todavía' });
    res.json(manifest);
  });

  router.get('/download', (req, res) => {
    if (!isValidSharedSecret(env.telemetrySharedSecret, req.query.key)) {
      return res.status(401).json({ error: 'Clave inválida' });
    }
    if (!fs.existsSync(apkPath)) return res.status(404).json({ error: 'Sin release publicado todavía' });
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.sendFile(apkPath);
  });

  router.post(
    '/release',
    authMiddleware,
    requireRole('admin'),
    upload.single('apk'),
    async (req, res) => {
      const file = req.file;
      try {
        const versionCode = parseInt(String(req.body.versionCode), 10);
        const versionName = String(req.body.versionName || '');
        if (!file || !Number.isInteger(versionCode) || !versionName) {
          return res.status(400).json({ error: 'apk, versionCode y versionName son requeridos' });
        }

        const buffer = await fsPromises.readFile(file.path);
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

        await fsPromises.rename(file.path, apkPath);
        const manifest: ReleaseManifest = {
          versionCode,
          versionName,
          sha256,
          sizeBytes: buffer.length,
          releasedAt: new Date().toISOString(),
        };
        await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

        res.status(201).json(manifest);
      } catch (err) {
        await fsPromises.rm(file?.path || '', { force: true }).catch(() => {});
        console.error('app-update.routes POST /release:', (err as Error).message);
        res.status(500).json({ error: 'Error publicando el release' });
      }
    },
  );

  return router;
}

export default buildAppUpdateRouter;
