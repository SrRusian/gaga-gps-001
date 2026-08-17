/**
 * device-sensors.routes.ts
 *
 * Receptor de snapshots de sensores del navegador (Operador) -
 * canal separado de /gps (Traccar Client), porque Traccar es una
 * app nativa que no tiene acceso a las APIs del navegador.
 */
import type { RequestHandler } from 'express';
import express from 'express';
import type DeviceSensorRepository from '../../repositories/DeviceSensorRepository';

const ALLOWED_SOURCES = new Set(['browser', 'browser_profile']);

export interface DeviceSensorsRouterDeps {
  sensorRepo: DeviceSensorRepository;
  authMiddleware: RequestHandler;
  requireRole: (...roles: string[]) => RequestHandler;
}

export function buildDeviceSensorsRouter({
  sensorRepo,
  authMiddleware,
  requireRole,
}: DeviceSensorsRouterDeps) {
  const router = express.Router();

  router.post('/:deviceId/sensors', authMiddleware, async (req, res) => {
    try {
      const deviceId = String(req.params.deviceId);
      const { data, source } = req.body;

      if (!data || typeof data !== 'object') {
        return res.status(400).json({ error: 'data (objeto) es requerido' });
      }

      const resolvedSource = ALLOWED_SOURCES.has(source) ? source : 'browser';
      const saved = await sensorRepo.save(deviceId, data, resolvedSource);
      res.status(201).json({ success: true, capturedAt: saved.captured_at });
    } catch (err) {
      console.error('device-sensors.routes POST /:deviceId/sensors:', (err as Error).message);
      res.status(500).json({ error: 'Error guardando snapshot de sensores' });
    }
  });

  // Solo para verificación/diagnóstico (admin/supervisor) - no hay
  // pantalla que lo consuma todavía.
  router.get(
    '/:deviceId/sensors',
    authMiddleware,
    requireRole('admin', 'supervisor'),
    async (req, res) => {
      try {
        const limit = req.query.limit ? Number(req.query.limit) : 50;
        const rows = await sensorRepo.findRecentByDevice(String(req.params.deviceId), limit);
        res.json(rows);
      } catch (err) {
        console.error('device-sensors.routes GET /:deviceId/sensors:', (err as Error).message);
        res.status(500).json({ error: 'Error obteniendo snapshots de sensores' });
      }
    },
  );

  return router;
}

export default buildDeviceSensorsRouter;
