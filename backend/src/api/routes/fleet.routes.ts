import express, { type RequestHandler } from 'express';
import type PreventiveStopService from '../../services/alerts/PreventiveStopService';
import type FleetStateManager from '../../services/telemetry/FleetStateManager';
import type { UserRole } from '../../repositories/UserRepository';

export function buildFleetRouter({
  preventiveStopService,
  fleetState,
  authMiddleware,
  requireRole,
}: {
  preventiveStopService: PreventiveStopService;
  fleetState: FleetStateManager;
  authMiddleware: RequestHandler;
  requireRole: (...roles: UserRole[]) => RequestHandler;
}) {
  const router = express.Router();

  router.get('/state', async (req, res) => {
    try {
      const fleet = await fleetState.getAll();
      res.json({ positions: Object.values(fleet), timestamp: new Date().toISOString() });
    } catch (err) {
      console.error('fleet.routes GET /state:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo estado de flota' });
    }
  });

  router.post(
    '/stop',
    authMiddleware,
    requireRole('admin', 'project_supervisor', 'project_administrator'),
    (req, res) => {
      const reason = req.body?.reason;
      preventiveStopService.activate(reason || 'Activado manualmente por supervisor', 'supervisor');
      res.json({ success: true, status: preventiveStopService.getStatus() });
    },
  );

  router.post(
    '/resume',
    authMiddleware,
    requireRole('admin', 'project_supervisor', 'project_administrator'),
    (req, res) => {
      preventiveStopService.deactivate('supervisor');
      res.json({ success: true, status: preventiveStopService.getStatus() });
    },
  );

  router.get('/stop/status', (req, res) => {
    res.json(preventiveStopService.getStatus());
  });

  return router;
}

export default buildFleetRouter;
