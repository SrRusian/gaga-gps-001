/**
 * reports.routes.ts
 *
 * Historial de posiciones (replay) y exportación CSV para el
 * panel admin. La exportación a PDF puede añadirse después con
 * una librería dedicada (p. ej. pdfkit) sin afectar este contrato.
 */
import type { Request, RequestHandler } from 'express';
import express from 'express';
import type DeviceRepository from '../../repositories/DeviceRepository';
import type { DeviceRow } from '../../repositories/DeviceRepository';
import GeofenceRepository from '../../repositories/GeofenceRepository';
import type PositionRepository from '../../repositories/PositionRepository';
import type { UserRole } from '../../repositories/UserRepository';
import { isInsideGeofence } from '../../utils/geometry';

type ResolveDeviceResult =
  | { error: number; message: string }
  | { device: DeviceRow; effectiveProjectId: number | null };

export interface ReportsRouterDeps {
  positionRepo: PositionRepository;
  geofenceRepo: GeofenceRepository;
  deviceRepo: DeviceRepository;
  requireRole: (...roles: UserRole[]) => RequestHandler;
}

export function buildReportsRouter({
  positionRepo,
  geofenceRepo,
  deviceRepo,
  requireRole,
}: ReportsRouterDeps) {
  const router = express.Router();

  // Antes solo exigía sesión válida (authMiddleware en app.ts), sin
  // restricción de rol - un Supervisor de Proyecto podía pedir el
  // historial de posiciones o el CSV de reportes por API directa
  // aunque su panel nunca expusiera esa opción ("no puede sacar
  // reportes ni ver el historial de recorridos" - la restricción
  // real tiene que vivir aquí, no solo en qué botones se muestran).
  const canView = requireRole('admin', 'project_manager');

  /**
   * Antes ninguna de las 3 rutas de este archivo comprobaba a qué
   * proyecto pertenece el `deviceId` consultado - un project_manager
   * podía pedir el historial de cualquier dispositivo de cualquier
   * otro proyecto. Admin (projectId null) sin `?projectId=` explícito
   * sigue viendo todo, igual que el resto del panel en alcance
   * "Global" - mismo patrón `req.user.projectId ?? query.projectId ?? null`
   * ya usado en geofences/equipment routes.
   */
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

  /**
   * Igual que /history, pero cada posición viene anotada con las
   * geocercas en las que estaba en ese momento - usado por el
   * visor de recorridos del panel Admin para colorear el trayecto
   * según si el vehículo circulaba dentro de una zona/ruta
   * autorizada o fuera de todas ellas.
   */
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
        // Antes sin filtrar (todas las geocercas de todos los
        // proyectos) - "zona" podía anotar una geocerca ajena al
        // proyecto del dispositivo consultado.
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

      // device_id es configurable libremente en la tableta (campo
      // "Device Identifier" de Traccar Client) y no es un dato
      // confiable - se escapa para exportación humana (Excel/Sheets)
      // en km/h para lectura directa por el usuario del reporte.
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

  return router;
}

/**
 * Escapa un valor para CSV - evita:
 *  - Inyección de fórmulas en Excel/Sheets (valores que empiezan
 *    con =, +, -, @ se prefijan con un apóstrofo)
 *  - Ruptura de columnas si el valor contiene comas, comillas o saltos de línea
 */
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
