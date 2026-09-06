import type { Request, RequestHandler } from 'express';
import express from 'express';
import type DeviceRepository from '../../repositories/DeviceRepository';
import type { DeviceRow } from '../../repositories/DeviceRepository';
import GeofenceRepository from '../../repositories/GeofenceRepository';
import type PositionRepository from '../../repositories/PositionRepository';
import type EquipmentActivityRepository from '../../repositories/EquipmentActivityRepository';
import type OperatorSessionRepository from '../../repositories/OperatorSessionRepository';
import type { UserRole } from '../../repositories/UserRepository';
import { isInsideGeofence } from '../../utils/geometry';

type ResolveDeviceResult =
  | { error: number; message: string }
  | { device: DeviceRow; effectiveProjectId: number | null };

export interface ReportsRouterDeps {
  positionRepo: PositionRepository;
  geofenceRepo: GeofenceRepository;
  deviceRepo: DeviceRepository;
  equipmentActivityRepo: EquipmentActivityRepository;
  operatorSessionRepo: OperatorSessionRepository;
  requireRole: (...roles: UserRole[]) => RequestHandler;
}

export function buildReportsRouter({
  positionRepo,
  geofenceRepo,
  deviceRepo,
  equipmentActivityRepo,
  operatorSessionRepo,
  requireRole,
}: ReportsRouterDeps) {
  const router = express.Router();
  const canView = requireRole('admin', 'project_administrator', 'project_manager');

  async function resolveDeviceForHistory(
    req: Request,
    deviceId: string,
  ): Promise<ResolveDeviceResult> {
    const device = await deviceRepo.findByUniqueId(deviceId);
    if (!device) return { error: 404, message: 'Dispositivo no encontrado' };

    const effectiveProjectId =
      req.user!.projectId ?? (req.query.projectId ? Number(req.query.projectId) : null);
    if (effectiveProjectId != null && device.project_id !== effectiveProjectId) {
      return { error: 403, message: 'El dispositivo no pertenece a este proyecto' };
    }
    return { device, effectiveProjectId };
  }

  router.get('/history', canView, async (req, res) => {
    try {
      const { deviceId, from, to, limit } = req.query;
      if (!deviceId || !from || !to) {
        return res.status(400).json({ error: 'deviceId, from y to son requeridos' });
      }

      const resolved = await resolveDeviceForHistory(req, String(deviceId));
      if ('error' in resolved) {
        return res.status(resolved.error).json({ error: resolved.message });
      }

      const history = await positionRepo.findHistory({
        deviceId: String(deviceId),
        from: new Date(String(from)),
        to: new Date(String(to)),
        limit: limit ? parseInt(String(limit), 10) : undefined,
      });

      res.json(history);
    } catch (err) {
      console.error('reports.routes GET /history:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo historial' });
    }
  });

  router.get('/history-with-zones', canView, async (req, res) => {
    try {
      const { deviceId, from, to, limit } = req.query;
      if (!deviceId || !from || !to) {
        return res.status(400).json({ error: 'deviceId, from y to son requeridos' });
      }

      const resolved = await resolveDeviceForHistory(req, String(deviceId));
      if ('error' in resolved) {
        return res.status(resolved.error).json({ error: resolved.message });
      }

      const [history, geofenceRows] = await Promise.all([
        positionRepo.findHistory({
          deviceId: String(deviceId),
          from: new Date(String(from)),
          to: new Date(String(to)),
          limit: limit ? parseInt(String(limit), 10) : undefined,
        }),
        geofenceRepo.findAllActive(resolved.effectiveProjectId),
      ]);

      const geofences = geofenceRows.map(GeofenceRepository.toMemoryFormat);

      const annotated = history.map((p) => {
        const zonesInside = geofences.filter((g) => isInsideGeofence(p.latitude, p.longitude, g));
        return {
          ...p,
          zones: zonesInside.map((g) => ({ id: g.id, name: g.name, type: g.type })),
        };
      });

      res.json(annotated);
    } catch (err) {
      console.error('reports.routes GET /history-with-zones:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo historial con zonas' });
    }
  });

  router.get('/history/csv', canView, async (req, res) => {
    try {
      const { deviceId, from, to } = req.query;
      if (!deviceId || !from || !to) {
        return res.status(400).json({ error: 'deviceId, from y to son requeridos' });
      }

      const resolved = await resolveDeviceForHistory(req, String(deviceId));
      if ('error' in resolved) {
        return res.status(resolved.error).json({ error: resolved.message });
      }

      const history = await positionRepo.findHistory({
        deviceId: String(deviceId),
        from: new Date(String(from)),
        to: new Date(String(to)),
      });

      const header = 'device_id,latitude,longitude,speed_kmh,course,altitude,fix_time\n';
      const csv =
        header +
        history
          .map((p) =>
            [
              csvEscape(p.device_id),
              p.latitude,
              p.longitude,
              (p.speed * 3.6).toFixed(1),
              p.course,
              p.altitude,
              p.fix_time instanceof Date ? p.fix_time.toISOString() : p.fix_time,
            ].join(','),
          )
          .join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="historial_${csvEscape(String(deviceId))}.csv"`,
      );
      res.send(csv);
    } catch (err) {
      console.error('reports.routes GET /history/csv:', (err as Error).message);
      res.status(500).json({ error: 'Error exportando CSV' });
    }
  });

  // distancia + tiempo productivo/improductivo/mantenimiento de un vehiculo en un rango - sin UI
  // todavia (mismo criterio que Produccion: endpoint listo, pantalla queda para cuando se pida)
  router.get('/vehicle-summary', canView, async (req, res) => {
    try {
      const { deviceId, from, to } = req.query;
      if (!deviceId || !from || !to) {
        return res.status(400).json({ error: 'deviceId, from y to son requeridos' });
      }

      const resolved = await resolveDeviceForHistory(req, String(deviceId));
      if ('error' in resolved) {
        return res.status(resolved.error).json({ error: resolved.message });
      }

      const [distanceMeters, activity] = await Promise.all([
        positionRepo.sumDistanceMeters({ deviceId: String(deviceId), from: String(from), to: String(to) }),
        equipmentActivityRepo.summarizeByDevice(String(deviceId), String(from), String(to)),
      ]);

      res.json({
        deviceId: String(deviceId),
        from: String(from),
        to: String(to),
        distanceMeters: Math.round(distanceMeters),
        productiveSeconds: Math.round(activity.productive),
        unproductiveSeconds: Math.round(activity.unproductive),
        maintenanceSeconds: Math.round(activity.maintenance),
      });
    } catch (err) {
      console.error('reports.routes GET /vehicle-summary:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo resumen del vehículo' });
    }
  });

  // igual que vehicle-summary pero por operador - un operador puede haber usado mas de un
  // vehiculo en el rango, la distancia se suma sesion por sesion
  router.get('/operator-summary', canView, async (req, res) => {
    try {
      const { userId, from, to } = req.query;
      if (!userId || !from || !to) {
        return res.status(400).json({ error: 'userId, from y to son requeridos' });
      }

      const sessions = await operatorSessionRepo.findReport({
        userId: parseInt(String(userId), 10),
        from: String(from),
        to: String(to),
      });

      const distances = await Promise.all(
        sessions.map((s) =>
          positionRepo.sumDistanceMeters({
            deviceId: s.device_id,
            from: s.started_at > new Date(String(from)) ? s.started_at : String(from),
            to: s.ended_at && s.ended_at < new Date(String(to)) ? s.ended_at : String(to),
          }),
        ),
      );
      const distanceMeters = distances.reduce((sum, d) => sum + d, 0);

      const activity = await equipmentActivityRepo.summarizeByOperatorSession(
        parseInt(String(userId), 10),
        String(from),
        String(to),
      );

      res.json({
        userId: parseInt(String(userId), 10),
        from: String(from),
        to: String(to),
        deviceIds: [...new Set(sessions.map((s) => s.device_id))],
        distanceMeters: Math.round(distanceMeters),
        productiveSeconds: Math.round(activity.productive),
        unproductiveSeconds: Math.round(activity.unproductive),
        maintenanceSeconds: Math.round(activity.maintenance),
      });
    } catch (err) {
      console.error('reports.routes GET /operator-summary:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo resumen del operador' });
    }
  });

  return router;
}

function csvEscape(value: unknown): string {
  let str = String(value ?? '');
  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n]/.test(str)) {
    str = `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export default buildReportsRouter;
