import type { RequestHandler } from 'express';
import express from 'express';
import type InfractionRepository from '../../repositories/InfractionRepository';
import type { UserRole } from '../../repositories/UserRepository';

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
      const rows = await infractionRepo.findByProject(projectId, { limit, offset });
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
