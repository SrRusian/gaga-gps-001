/**
 * operator-sessions.routes.ts
 *
 * Registro de turnos operador-vehículo. `/active` es pública (la
 * consulta la propia UI de operador antes de iniciar sesión, para
 * saber si ya hay alguien en turno en ese dispositivo) - el resto
 * requiere JWT, igual que el panel admin.
 */
import type { RequestHandler } from 'express';
import express from 'express';
import OperatorSessionRepository, {
  DeviceNotRegisteredError,
} from '../../repositories/OperatorSessionRepository';
import type DeviceRepository from '../../repositories/DeviceRepository';
import type EquipmentRepository from '../../repositories/EquipmentRepository';
import type { EquipmentRow } from '../../repositories/EquipmentRepository';
import type { UserRole } from '../../repositories/UserRepository';
import type ShiftResolverService from '../../services/telemetry/ShiftResolverService';
import type StaticEquipmentManager from '../../services/static_equipment/StaticEquipmentManager';

interface SocketServerLike {
  broadcastToProject(projectId: number | null, event: string, payload: unknown): void;
}

export interface OperatorSessionsRouterDeps {
  operatorSessionRepo: OperatorSessionRepository;
  deviceRepo: DeviceRepository;
  equipmentRepo: EquipmentRepository;
  equipmentManager: StaticEquipmentManager;
  socketServer: SocketServerLike;
  shiftResolver: ShiftResolverService;
  authMiddleware: RequestHandler;
  requireRole: (...roles: UserRole[]) => RequestHandler;
}

function toEquipmentInfo(eq: EquipmentRow) {
  return {
    id: eq.id,
    name: eq.name,
    type: eq.type,
    swingRadiusMeters: eq.swing_radius,
    safetyRadiusMeters: eq.safety_radius,
  };
}

export function buildOperatorSessionsRouter({
  operatorSessionRepo,
  deviceRepo,
  equipmentRepo,
  equipmentManager,
  socketServer,
  shiftResolver,
  authMiddleware,
  requireRole,
}: OperatorSessionsRouterDeps) {
  const router = express.Router();

  // El estado real de un equipo con tableta vinculada se deriva 100%
  // de si hay turno activo en esa tableta ahora mismo - una sola
  // fuente de verdad (ver CLAUDE.md, decisión confirmada con el
  // usuario). `PATCH /api/equipment/:id/status` sigue existiendo para
  // equipo SIN tableta vinculada (la UI de Admin ya no lo ofrece
  // cuando sí la tiene).
  async function setEquipmentStatusForDevice(
    deviceId: string,
    status: 'active_pause' | 'inactive',
  ): Promise<void> {
    const eq = await equipmentRepo.findByLinkedDevice(deviceId);
    if (!eq) return;
    await equipmentRepo.updateStatus(eq.id, status);
    equipmentManager.updateStatus(eq.id, status);
    const scoped = Object.values(equipmentManager.equipment).filter(
      (e) => e.projectId === eq.project_id,
    );
    socketServer.broadcastToProject(eq.project_id, 'equipment:update', scoped);
  }

  router.get('/active', async (req, res) => {
    try {
      const { deviceId } = req.query;
      if (!deviceId) return res.status(400).json({ error: 'deviceId es requerido' });
      const session = await operatorSessionRepo.findActiveByDevice(String(deviceId));
      if (!session) return res.json(null);
      const equipment = await equipmentRepo.findByLinkedDevice(String(deviceId));
      res.json({ ...session, equipment: equipment ? toEquipmentInfo(equipment) : null });
    } catch (err) {
      console.error('operator-sessions.routes GET /active:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo turno activo' });
    }
  });

  router.post('/start', authMiddleware, async (req, res) => {
    try {
      const { deviceId } = req.body;
      if (!deviceId) return res.status(400).json({ error: 'deviceId es requerido' });

      // Resuelve el turno programado (shift) que aplica ahora mismo
      // para el proyecto de este dispositivo - el operador no elige
      // nada, es automático por horario (ver ShiftResolverService).
      const device = await deviceRepo.findByUniqueId(deviceId);
      const shiftId =
        device?.project_id != null ? await shiftResolver.resolveForProject(device.project_id) : null;

      const session = await operatorSessionRepo.start({ userId: req.user!.id, deviceId, shiftId });

      const equipment = await equipmentRepo.findByLinkedDevice(deviceId);
      if (equipment) await setEquipmentStatusForDevice(deviceId, 'active_pause');

      res.status(201).json({
        ...session,
        equipment: equipment ? toEquipmentInfo(equipment) : null,
      });
    } catch (err) {
      if (err instanceof DeviceNotRegisteredError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      console.error('operator-sessions.routes POST /start:', (err as Error).message);
      res.status(500).json({ error: 'Error iniciando turno' });
    }
  });

  router.post('/:id/end', authMiddleware, async (req, res) => {
    try {
      const session = await operatorSessionRepo.end(Number(req.params.id));
      if (!session) return res.status(404).json({ error: 'Turno no encontrado o ya cerrado' });
      await setEquipmentStatusForDevice(session.device_id, 'inactive');
      res.json(session);
    } catch (err) {
      console.error('operator-sessions.routes POST /:id/end:', (err as Error).message);
      res.status(500).json({ error: 'Error cerrando turno' });
    }
  });

  // Heartbeat periódico desde la UI de operador - mientras siga
  // llegando, el turno se considera activo indefinidamente; si deja
  // de llegar por más de N días, se cierra automáticamente (ver
  // OperatorSessionRepository.closeStaleSessions, llamado desde app.js).
  router.post('/:id/heartbeat', authMiddleware, async (req, res) => {
    try {
      const session = await operatorSessionRepo.touch(Number(req.params.id));
      if (!session) return res.status(404).json({ error: 'Turno no encontrado o ya cerrado' });
      res.json({ success: true });
    } catch (err) {
      console.error('operator-sessions.routes POST /:id/heartbeat:', (err as Error).message);
      res.status(500).json({ error: 'Error registrando actividad' });
    }
  });

  // Reporte de horas trabajadas - por operador y/o por vehículo,
  // solo para supervisión/administración.
  router.get(
    '/report',
    authMiddleware,
    requireRole('admin', 'project_manager', 'project_supervisor'),
    async (req, res) => {
      try {
        const { userId, deviceId, from, to } = req.query;
        if (!from || !to) return res.status(400).json({ error: 'from y to son requeridos' });
        const sessions = await operatorSessionRepo.findReport({
          userId: userId ? parseInt(String(userId), 10) : undefined,
          deviceId: deviceId ? String(deviceId) : undefined,
          from: new Date(String(from)),
          to: new Date(String(to)),
        });
        res.json(sessions);
      } catch (err) {
        console.error('operator-sessions.routes GET /report:', (err as Error).message);
        res.status(500).json({ error: 'Error obteniendo reporte de turnos' });
      }
    },
  );

  return router;
}

export default buildOperatorSessionsRouter;
