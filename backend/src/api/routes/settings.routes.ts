import type { RequestHandler } from 'express';
import express from 'express';
import { env } from '../../config';
import type SystemSettingsRepository from '../../repositories/SystemSettingsRepository';
import type { UserRole } from '../../repositories/UserRepository';
import { fetchNtripSourceTable } from '../../utils/ntripSourceTable';

const EDITABLE_KEYS = [
  'telemetrySharedSecret',
  'ntripDefaultName',
  'ntripDefaultHost',
  'ntripDefaultPort',
  'ntripDefaultUsername',
  'ntripDefaultPassword',
  'ntripDefaultMountpoint',
  'ntripDefaultVersion',
] as const;
type EditableKey = (typeof EDITABLE_KEYS)[number];

export interface SettingsRouterDeps {
  settingsRepo: SystemSettingsRepository;
  authMiddleware: RequestHandler;
  requireRole: (...roles: UserRole[]) => RequestHandler;
}

export function buildSettingsRouter({ settingsRepo, authMiddleware, requireRole }: SettingsRouterDeps) {
  const router = express.Router();
  const adminOnly = requireRole('admin');

  router.get('/', authMiddleware, adminOnly, async (req, res) => {
    try {
      res.json({
        telemetrySharedSecret: env.telemetrySharedSecret,
        ntripDefaultName: env.ntripDefault.name,
        ntripDefaultHost: env.ntripDefault.host,
        ntripDefaultPort: env.ntripDefault.port,
        ntripDefaultUsername: env.ntripDefault.username,
        ntripDefaultPassword: env.ntripDefault.password,
        ntripDefaultMountpoint: env.ntripDefault.mountpoint,
        ntripDefaultVersion: env.ntripDefault.version,
      });
    } catch (err) {
      console.error('settings.routes GET /:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo configuración' });
    }
  });

  router.patch('/', authMiddleware, adminOnly, async (req, res) => {
    try {
      const { key, value } = req.body as { key?: string; value?: string | null };
      if (!EDITABLE_KEYS.includes(key as EditableKey)) {
        return res.status(400).json({ error: `key debe ser una de: ${EDITABLE_KEYS.join(', ')}` });
      }

      await settingsRepo.set(key as EditableKey, value ?? null, req.user!.id);

      // aplica en caliente, sin reiniciar el proceso - no toca el .env
      switch (key as EditableKey) {
        case 'telemetrySharedSecret':
          env.telemetrySharedSecret = value ?? null;
          break;
        case 'ntripDefaultName':
          env.ntripDefault.name = value || 'Principal';
          break;
        case 'ntripDefaultHost':
          env.ntripDefault.host = value || null;
          break;
        case 'ntripDefaultPort':
          env.ntripDefault.port = parseInt(value ?? '', 10) || 2101;
          break;
        case 'ntripDefaultUsername':
          env.ntripDefault.username = value || null;
          break;
        case 'ntripDefaultPassword':
          env.ntripDefault.password = value || null;
          break;
        case 'ntripDefaultMountpoint':
          env.ntripDefault.mountpoint = value || null;
          break;
        case 'ntripDefaultVersion':
          env.ntripDefault.version = value === 'v1' ? 'v1' : 'v2';
          break;
      }

      res.json({ success: true });
    } catch (err) {
      console.error('settings.routes PATCH /:', (err as Error).message);
      res.status(500).json({ error: 'Error actualizando configuración' });
    }
  });

  // consulta en vivo la tabla de fuentes del caster (host/puerto ya escritos en el formulario) -
  // para que el punto de montura de fábrica se ELIJA de la lista real, nunca se teclee a mano
  // (evita un typo silencioso que solo se nota cuando una tableta ya en campo falla al conectar)
  router.post('/ntrip-mountpoints', authMiddleware, adminOnly, async (req, res) => {
    const { host, port } = req.body as { host?: string; port?: number };
    if (!host || !port) {
      return res.status(400).json({ error: 'host y port son requeridos' });
    }
    try {
      const mountpoints = await fetchNtripSourceTable(host, Number(port));
      res.json({ mountpoints });
    } catch (err) {
      console.error('settings.routes POST /ntrip-mountpoints:', (err as Error).message);
      res.status(502).json({ error: (err as Error).message || 'Error consultando el caster' });
    }
  });

  return router;
}

export default buildSettingsRouter;
