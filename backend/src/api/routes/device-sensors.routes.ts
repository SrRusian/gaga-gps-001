import type { RequestHandler } from 'express';
import express from 'express';
import type DeviceRepository from '../../repositories/DeviceRepository';
import type DeviceSensorRepository from '../../repositories/DeviceSensorRepository';

const ALLOWED_SOURCES = new Set(['browser', 'browser_profile']);

export interface DeviceSensorsRouterDeps {
  sensorRepo: DeviceSensorRepository;
  deviceRepo: DeviceRepository;
  authMiddleware: RequestHandler;
  requireRole: (...roles: string[]) => RequestHandler;
}

export function buildDeviceSensorsRouter({
  sensorRepo,
  deviceRepo,
  authMiddleware,
  requireRole,
}: DeviceSensorsRouterDeps) {
  const router = express.Router();

  router.post('/:deviceId/sensors', authMiddleware, async (req, res) => {
    try {
      // deviceId debe existir ya en devices (FK) - a diferencia de /gps, no auto-registra
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

  router.get(
    '/:deviceId/sensors',
    authMiddleware,
    requireRole('admin', 'project_administrator', 'project_supervisor', 'project_manager'),
    async (req, res) => {
      try {
        const deviceId = String(req.params.deviceId);
        const device = await deviceRepo.findByUniqueId(deviceId);
        if (!device) return res.status(404).json({ error: 'Dispositivo no encontrado' });
        if (req.user!.projectId != null && device.project_id !== req.user!.projectId) {
          return res.status(404).json({ error: 'Dispositivo no encontrado' });
        }

        const limit = req.query.limit ? Number(req.query.limit) : 50;
        const rows = await sensorRepo.findRecentByDevice(deviceId, limit);
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
