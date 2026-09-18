import type { RequestHandler } from 'express';
import express from 'express';
import type AlertEventRepository from '../../repositories/AlertEventRepository';
import type { AlertSeverity, AlertType } from '../../repositories/AlertEventRepository';
import type { UserRole } from '../../repositories/UserRepository';

const VALID_TYPES: AlertType[] = [
  'geofence',
  'signal_lost',
  'collision',
  'proximity',
  'preventive_stop',
  'incident',
];
const VALID_SEVERITIES: AlertSeverity[] = ['info', 'warning', 'danger'];

// tope por peticion, no del total: la tableta manda el historico sin conexion en tandas sucesivas
// hasta vaciar su cola, sin limite de cuantas tandas (pedido explicito: no perder ningun dato)
const MAX_OFFLINE_BATCH = 500;

interface GeofenceEventRepoLike {
  record(input: {
    deviceId: string;
    geofenceId: number | null;
    eventType: 'enter' | 'exit';
    severity?: string | null;
  }): Promise<unknown>;
}

export interface AlertsRouterDeps {
  alertEventRepo: AlertEventRepository;
  requireRole: (...roles: UserRole[]) => RequestHandler;
  geofenceEventRepo?: GeofenceEventRepoLike;
}

function computeFilters(req: express.Request) {
  const { type, severity, deviceId, from, to, limit, offset } = req.query;

  if (type && !VALID_TYPES.includes(type as AlertType)) {
    throw new Error(`type inválido - use: ${VALID_TYPES.join(', ')}`);
  }
  if (severity && !VALID_SEVERITIES.includes(severity as AlertSeverity)) {
    throw new Error(`severity inválida - use: ${VALID_SEVERITIES.join(', ')}`);
  }

  return {
    projectId: req.user!.role === 'admin' ? null : (req.user!.projectId ?? null),
    alertType: type ? (String(type) as AlertType) : undefined,
    severity: severity ? (String(severity) as AlertSeverity) : undefined,
    deviceId: deviceId ? String(deviceId) : undefined,
    from: from ? String(from) : undefined,
    to: to ? String(to) : undefined,
    limit: limit ? Math.min(parseInt(String(limit), 10), 500) : undefined,
    offset: offset ? parseInt(String(offset), 10) : undefined,
  };
}

export function buildAlertsRouter({ alertEventRepo, requireRole, geofenceEventRepo }: AlertsRouterDeps) {
  const router = express.Router();
  // project_supervisor deliberadamente fuera - pedido explicito: solo ve "su turno" (via
  // /api/infractions y /api/incidents/history, ambos acotados al dia actual), sin acceso al
  // historial completo. Encargado (project_manager) si puede filtrar libremente por fecha.
  // (esto tambien dejo sin uso a ShiftResolverService.mostRecentShiftStartForSupervisor, que
  // existia solo para acotar esta ruta al turno del supervisor - se deja el metodo en el servicio
  // por si algo mas lo necesita a futuro, no tiene otro caller hoy)
  const canView = requireRole('admin', 'project_administrator', 'project_manager');

  router.get('/history', canView, async (req, res) => {
    try {
      const filters = computeFilters(req);
      const rows = await alertEventRepo.findHistory(filters);
      res.json(rows);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('type inválido')) {
        return res.status(400).json({ error: err.message });
      }
      if (err instanceof Error && err.message.startsWith('severity inválida')) {
        return res.status(400).json({ error: err.message });
      }
      console.error('alerts.routes GET /history:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo historial de alertas' });
    }
  });

  router.get('/history/csv', canView, async (req, res) => {
    try {
      const filters = computeFilters(req);
      const rows = await alertEventRepo.findHistory({ ...filters, limit: 5000 });

      const header = 'fecha,tipo,severidad,dispositivo,dispositivo_2,mensaje,resuelto_en\n';
      const csv =
        header +
        rows
          .map((r) =>
            [
              r.triggered_at instanceof Date ? r.triggered_at.toISOString() : r.triggered_at,
              r.alert_type,
              r.severity,
              csvEscape(r.device_id),
              csvEscape(r.device_id_2),
              csvEscape(r.message),
              r.resolved_at ? (r.resolved_at instanceof Date ? r.resolved_at.toISOString() : r.resolved_at) : '',
            ].join(','),
          )
          .join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="historial_alertas.csv"');
      res.send(csv);
    } catch (err) {
      if (err instanceof Error && (err.message.startsWith('type inválido') || err.message.startsWith('severity inválida'))) {
        return res.status(400).json({ error: err.message });
      }
      console.error('alerts.routes GET /history/csv:', (err as Error).message);
      res.status(500).json({ error: 'Error exportando CSV' });
    }
  });

  // Ingesta de las alertas de geocerca que el Operador genero SIN conexion y recien pudo mandar.
  // Sin restriccion de rol mas alla de estar autenticado: el unico que llama esto es la propia
  // tableta con su sesion de operador. Cada elemento es un hecho ya ocurrido y ya terminado, con su
  // fecha real - nunca toca el estado de alertas EN VIVO (ver recordHistorical).
  router.post('/offline-batch', async (req, res) => {
    try {
      const items = req.body?.alerts;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Se espera { alerts: [...] } con al menos un elemento' });
      }
      if (items.length > MAX_OFFLINE_BATCH) {
        return res.status(400).json({ error: `Maximo ${MAX_OFFLINE_BATCH} alertas por lote` });
      }

      let stored = 0;
      for (const item of items) {
        const severity = String(item?.severity) as AlertSeverity;
        const deviceId = item?.deviceId ? String(item.deviceId) : null;
        const occurredAt = new Date(item?.occurredAt);
        if (!deviceId || !VALID_SEVERITIES.includes(severity) || Number.isNaN(occurredAt.getTime())) {
          continue; // un elemento corrupto no debe tirar el lote entero
        }

        await alertEventRepo.recordHistorical({
          alertType: 'geofence',
          severity,
          deviceId,
          message: item?.message ? String(item.message) : null,
          metadata: {
            offline: true,
            geofenceId: item?.geofenceId ?? null,
            geofenceName: item?.geofenceName ?? null,
            event: item?.event ?? null,
            latitude: item?.latitude ?? null,
            longitude: item?.longitude ?? null,
          },
          occurredAt,
        });

        if (geofenceEventRepo && typeof item?.geofenceId === 'number') {
          await geofenceEventRepo.record({
            deviceId,
            geofenceId: item.geofenceId,
            eventType: item?.event === 'exit' ? 'exit' : 'enter',
            severity,
          });
        }
        stored += 1;
      }

      res.json({ success: true, stored });
    } catch (err) {
      console.error('alerts.routes POST /offline-batch:', (err as Error).message);
      res.status(500).json({ error: 'Error guardando alertas sin conexión' });
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

export default buildAlertsRouter;
