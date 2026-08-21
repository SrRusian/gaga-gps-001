import type { RequestHandler } from 'express';
import express from 'express';
import { env } from '../../config';
import type SystemSettingsRepository from '../../repositories/SystemSettingsRepository';
import type { UserRole } from '../../repositories/UserRepository';

const EDITABLE_KEYS = ['telemetrySharedSecret'] as const;
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
      res.json({ telemetrySharedSecret: env.telemetrySharedSecret });
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
      if (key === 'telemetrySharedSecret') {
        env.telemetrySharedSecret = value ?? null;
      }

      res.json({ success: true });
    } catch (err) {
      console.error('settings.routes PATCH /:', (err as Error).message);
      res.status(500).json({ error: 'Error actualizando configuración' });
    }
  });

  return router;
}

export default buildSettingsRouter;
