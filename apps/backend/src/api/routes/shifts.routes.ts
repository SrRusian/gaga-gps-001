/**
 * shifts.routes.ts
 *
 * CRUD de turnos programados (horario recurrente diario por
 * proyecto) - Admin y Encargado de Proyecto los crean/editan y
 * asignan un Supervisor de Proyecto a cada uno. `/mine` es lo que
 * consulta el panel de un Supervisor de Proyecto para saber qué
 * turno le tocó y qué vehículos/operadores están activos en él
 * ahora mismo - no elige nada, solo se le informa.
 */
import type { RequestHandler } from 'express';
import express from 'express';
import type OperatorSessionRepository from '../../repositories/OperatorSessionRepository';
import type ShiftRepository from '../../repositories/ShiftRepository';
import type { UserRole } from '../../repositories/UserRepository';

export interface ShiftsRouterDeps {
  shiftRepo: ShiftRepository;
  operatorSessionRepo: OperatorSessionRepository;
  requireRole: (...roles: UserRole[]) => RequestHandler;
}

export function buildShiftsRouter({
  shiftRepo,
  operatorSessionRepo,
  requireRole,
}: ShiftsRouterDeps) {
  const router = express.Router();

  const canManage = requireRole('admin', 'project_manager');

  // Turno(s) asignado(s) al Supervisor de Proyecto que hace la
  // consulta, con el roster de operadores/vehículos activos ahora
  // mismo bajo cada uno.
  router.get('/mine', requireRole('project_supervisor'), async (req, res) => {
    try {
      const shifts = await shiftRepo.findBySupervisor(req.user!.id);
      const withRoster = await Promise.all(
        shifts.map(async (shift) => ({
          ...shift,
          roster: await operatorSessionRepo.findActiveByShift(shift.id),
        })),
      );
      res.json(withRoster);
    } catch (err) {
      console.error('shifts.routes GET /mine:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo turno asignado' });
    }
  });

  router.get('/', canManage, async (req, res) => {
    try {
      const projectId = req.user!.projectId ?? Number(req.query.projectId);
      if (!projectId) {
        return res.status(400).json({ error: 'projectId es requerido' });
      }
      const shifts = await shiftRepo.findByProject(projectId);
      res.json(shifts);
    } catch (err) {
      console.error('shifts.routes GET /:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo turnos' });
    }
  });

  router.post('/', canManage, async (req, res) => {
    try {
      const { name, startTime, endTime, supervisorUserId } = req.body;
      const projectId = req.user!.projectId ?? req.body.projectId ?? null;
      if (!name || !startTime || !endTime) {
        return res.status(400).json({ error: 'name, startTime y endTime son requeridos' });
      }
      if (!projectId) {
        return res.status(400).json({ error: 'projectId es requerido' });
      }
      const shift = await shiftRepo.create({ projectId, name, startTime, endTime, supervisorUserId });
      res.status(201).json(shift);
    } catch (err) {
      console.error('shifts.routes POST /:', (err as Error).message);
      res.status(500).json({ error: 'Error creando turno' });
    }
  });

  router.patch('/:id', canManage, async (req, res) => {
    try {
      const existing = await shiftRepo.findById(Number(req.params.id));
      if (!existing) return res.status(404).json({ error: 'Turno no encontrado' });
      if (req.user!.projectId != null && existing.project_id !== req.user!.projectId) {
        return res.status(404).json({ error: 'Turno no encontrado' });
      }

      const { name, startTime, endTime, supervisorUserId, active } = req.body;
      const shift = await shiftRepo.update(Number(req.params.id), {
        name,
        startTime,
        endTime,
        supervisorUserId,
        active,
      });
      res.json(shift);
    } catch (err) {
      console.error('shifts.routes PATCH /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error actualizando turno' });
    }
  });

  router.delete('/:id', canManage, async (req, res) => {
    try {
      const existing = await shiftRepo.findById(Number(req.params.id));
      if (!existing) return res.status(404).json({ error: 'Turno no encontrado' });
      if (req.user!.projectId != null && existing.project_id !== req.user!.projectId) {
        return res.status(404).json({ error: 'Turno no encontrado' });
      }
      await shiftRepo.delete(Number(req.params.id));
      res.json({ success: true });
    } catch (err) {
      console.error('shifts.routes DELETE /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error eliminando turno' });
    }
  });

  return router;
}

export default buildShiftsRouter;
