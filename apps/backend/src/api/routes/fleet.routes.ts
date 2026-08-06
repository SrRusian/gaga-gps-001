/**
 * fleet.routes.ts
 *
 * Estado general de la flota y control de parada preventiva
 * colectiva (RF-ALR-11). Extraído de app.js sin cambiar su
 * comportamiento.
 */
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
      console.error('❌ fleet.routes GET /state:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo estado de flota' });
    }
  });

  // Activar/desactivar la parada preventiva colectiva es una acción
  // de seguridad crítica — antes no requería login (Supervisor era
  // una pantalla compartida sin cuenta); ahora que todos los roles
  // tienen usuario y contraseña, se protege con JWT + rol.
  router.post('/stop', authMiddleware, requireRole('supervisor', 'admin'), (req, res) => {
    const reason = req.body?.reason;
    preventiveStopService.activate(reason || 'Activado manualmente por supervisor', 'supervisor');
    res.json({ success: true, status: preventiveStopService.getStatus() });
  });

  router.post('/resume', authMiddleware, requireRole('supervisor', 'admin'), (req, res) => {
    preventiveStopService.deactivate('supervisor');
    res.json({ success: true, status: preventiveStopService.getStatus() });
  });

  router.get('/stop/status', (req, res) => {
    res.json(preventiveStopService.getStatus());
  });

  return router;
}

export default buildFleetRouter;
