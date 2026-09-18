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

export interface AlertsRouterDeps {
  alertEventRepo: AlertEventRepository;
  requireRole: (...roles: UserRole[]) => RequestHandler;
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

export function buildAlertsRouter({ alertEventRepo, requireRole }: AlertsRouterDeps) {
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
