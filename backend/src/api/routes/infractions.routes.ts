import type { RequestHandler } from 'express';
import express from 'express';
import type InfractionRepository from '../../repositories/InfractionRepository';
import type { UserRole } from '../../repositories/UserRepository';
import { startOfTodayIso } from '../../utils/dateScope';

export interface InfractionsRouterDeps {
  infractionRepo: InfractionRepository;
  authMiddleware: RequestHandler;
  requireRole: (...roles: UserRole[]) => RequestHandler;
}

// historial de solo lectura - las filas las genera unicamente el sistema (SpeedAlertService/
// GeofenceAlertService), no hay POST de creacion manual. canView incluye a todos los roles con
// acceso a un proyecto (mismo criterio que alerts.routes.ts); canManage (marcar revisada) se acota
// a quien ya puede resolver incidentes.
export function buildInfractionsRouter({ infractionRepo, authMiddleware, requireRole }: InfractionsRouterDeps) {
  const router = express.Router();
  const canView = requireRole('admin', 'project_administrator', 'project_supervisor', 'project_manager');
  const canManage = requireRole('admin', 'project_administrator', 'project_supervisor');

  router.get('/', authMiddleware, canView, async (req, res) => {
    try {
      const projectId = req.user!.role === 'admin' ? null : (req.user!.projectId ?? null);
      const limit = req.query.limit ? Math.min(parseInt(String(req.query.limit), 10), 500) : undefined;
      const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : undefined;

      // Supervisor solo ve "su turno" (por ahora, el dia calendario actual) y no puede pedir un
      // rango propio - Encargado (y admin/project_administrator) sí filtran libremente por fecha
      const isSupervisor = req.user!.role === 'project_supervisor';
      const from = isSupervisor ? startOfTodayIso() : (req.query.from ? String(req.query.from) : undefined);
      const to = isSupervisor ? undefined : (req.query.to ? String(req.query.to) : undefined);
      const deviceId = req.query.deviceId ? String(req.query.deviceId) : undefined;
      const operatorName = req.query.operatorName ? String(req.query.operatorName) : undefined;

      const rows = await infractionRepo.findByProject(projectId, {
        limit,
        offset,
        from,
        to,
        deviceId,
        operatorName,
      });
      res.json(rows);
    } catch (err) {
      console.error('infractions.routes GET /:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo infracciones' });
    }
  });

  router.post('/:id/review', authMiddleware, canManage, async (req, res) => {
    try {
      const infraction = await infractionRepo.markReviewed(
        Number(req.params.id),
        req.user!.id,
        req.body?.notes,
      );
      if (!infraction) return res.status(404).json({ error: 'Infracción no encontrada' });
      res.json(infraction);
    } catch (err) {
      console.error('infractions.routes POST /:id/review:', (err as Error).message);
      res.status(500).json({ error: 'Error marcando infracción como revisada' });
    }
  });

  return router;
}

export default buildInfractionsRouter;
