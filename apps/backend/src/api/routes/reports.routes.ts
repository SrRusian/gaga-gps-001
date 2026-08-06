/**
 * reports.routes.ts
 *
 * Historial de posiciones (replay) y exportación CSV para el
 * panel admin. La exportación a PDF puede añadirse después con
 * una librería dedicada (p. ej. pdfkit) sin afectar este contrato.
 */
import express from 'express';
import GeofenceRepository from '../../repositories/GeofenceRepository';
import type PositionRepository from '../../repositories/PositionRepository';
import { isInsideGeofence } from '../../utils/geometry';

export interface ReportsRouterDeps {
  positionRepo: PositionRepository;
  geofenceRepo: GeofenceRepository;
}

export function buildReportsRouter({ positionRepo, geofenceRepo }: ReportsRouterDeps) {
  const router = express.Router();

  router.get('/history', async (req, res) => {
    try {
      const { deviceId, from, to, limit } = req.query;
      if (!deviceId || !from || !to) {
        return res.status(400).json({ error: 'deviceId, from y to son requeridos' });
      }

      const history = await positionRepo.findHistory({
        deviceId: String(deviceId),
        from: new Date(String(from)),
        to: new Date(String(to)),
        limit: limit ? parseInt(String(limit), 10) : undefined,
      });

      res.json(history);
    } catch (err) {
      console.error('❌ reports.routes GET /history:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo historial' });
    }
  });

  /**
   * Igual que /history, pero cada posición viene anotada con las
   * geocercas en las que estaba en ese momento — usado por el
   * visor de recorridos del panel Admin para colorear el trayecto
   * según si el vehículo circulaba dentro de una zona/ruta
   * autorizada o fuera de todas ellas.
   */
  router.get('/history-with-zones', async (req, res) => {
    try {
      const { deviceId, from, to, limit } = req.query;
      if (!deviceId || !from || !to) {
        return res.status(400).json({ error: 'deviceId, from y to son requeridos' });
      }

      const [history, geofenceRows] = await Promise.all([
        positionRepo.findHistory({
          deviceId: String(deviceId),
          from: new Date(String(from)),
          to: new Date(String(to)),
          limit: limit ? parseInt(String(limit), 10) : undefined,
        }),
        geofenceRepo.findAllActive(),
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
      console.error('❌ reports.routes GET /history-with-zones:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo historial con zonas' });
    }
  });

  router.get('/history/csv', async (req, res) => {
    try {
      const { deviceId, from, to } = req.query;
      if (!deviceId || !from || !to) {
        return res.status(400).json({ error: 'deviceId, from y to son requeridos' });
      }

      const history = await positionRepo.findHistory({
        deviceId: String(deviceId),
        from: new Date(String(from)),
        to: new Date(String(to)),
      });

      // device_id es configurable libremente en la tableta (campo
      // "Device Identifier" de Traccar Client) y no es un dato
      // confiable — se escapa para exportación humana (Excel/Sheets)
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
      console.error('❌ reports.routes GET /history/csv:', (err as Error).message);
      res.status(500).json({ error: 'Error exportando CSV' });
    }
  });

  return router;
}

/**
 * Escapa un valor para CSV — evita:
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
