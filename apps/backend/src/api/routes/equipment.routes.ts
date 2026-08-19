import express from 'express';
import { DeviceAlreadyLinkedError } from '../../repositories/EquipmentRepository';
import type EquipmentRepository from '../../repositories/EquipmentRepository';
import type StaticEquipmentManager from '../../services/static_equipment/StaticEquipmentManager';

interface SocketServerLike {
  broadcast(event: string, payload: unknown): void;
  broadcastToProject(projectId: number | null, event: string, payload: unknown): void;
}

export interface EquipmentRouterDeps {
  equipmentRepo: EquipmentRepository;
  equipmentManager: StaticEquipmentManager;
  socketServer: SocketServerLike;
}

export function buildEquipmentRouter({
  equipmentRepo,
  equipmentManager,
  socketServer,
}: EquipmentRouterDeps) {
  const router = express.Router();

  function broadcastEquipmentUpdate(projectId: number | null) {
    const scoped = Object.values(equipmentManager.equipment).filter(
      (eq) => eq.projectId === projectId,
    );
    socketServer.broadcastToProject(projectId, 'equipment:update', scoped);
  }

  router.get('/', async (req, res) => {
    try {
      const equipment = await equipmentRepo.findAll(req.user?.projectId);
      res.json(equipment);
    } catch (err) {
      console.error('equipment.routes GET /:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo equipo estático' });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { name, type, latitude, longitude, swingRadius, safetyRadius, status, linkedDeviceId } =
        req.body;
      if (
        !name ||
        !type ||
        latitude === undefined ||
        longitude === undefined ||
        !swingRadius ||
        !safetyRadius
      ) {
        return res.status(400).json({ error: 'Faltan campos requeridos' });
      }

      const projectId = req.user!.projectId ?? req.body.projectId ?? null;
      if (projectId === null) {
        return res.status(400).json({ error: 'projectId es requerido' });
      }

      const eq = await equipmentRepo.create({
        name,
        projectId,
        type,
        latitude,
        longitude,
        swingRadius,
        safetyRadius,
        status,
        linkedDeviceId: linkedDeviceId ?? null,
      });

      equipmentManager.registerEquipment({
        id: eq.id,
        projectId: eq.project_id,
        name: eq.name,
        type: eq.type,
        lat: eq.latitude,
        lon: eq.longitude,
        swingRadius: eq.swing_radius,
        safetyRadius: eq.safety_radius,
        status: eq.status,
        linkedDeviceId: eq.linked_device_id,
      });

      broadcastEquipmentUpdate(eq.project_id);
      res.status(201).json(eq);
    } catch (err) {
      if (err instanceof DeviceAlreadyLinkedError) {
        return res.status(409).json({ error: err.message, code: err.code });
      }
      console.error('equipment.routes POST /:', (err as Error).message);
      res.status(500).json({ error: 'Error creando equipo estático' });
    }
  });

  router.patch('/:id', async (req, res) => {
    try {
      const { name, type, latitude, longitude, swingRadius, safetyRadius, linkedDeviceId } = req.body;
      const eq = await equipmentRepo.update(Number(req.params.id), {
        name,
        type,
        latitude,
        longitude,
        swingRadius,
        safetyRadius,
        linkedDeviceId: 'linkedDeviceId' in req.body ? linkedDeviceId : undefined,
      });
      if (!eq) return res.status(404).json({ error: 'Equipo no encontrado' });

      equipmentManager.registerEquipment({
        id: eq.id,
        projectId: eq.project_id,
        name: eq.name,
        type: eq.type,
        lat: eq.latitude,
        lon: eq.longitude,
        swingRadius: eq.swing_radius,
        safetyRadius: eq.safety_radius,
        status: eq.status,
        linkedDeviceId: eq.linked_device_id,
      });

      broadcastEquipmentUpdate(eq.project_id);
      res.json(eq);
    } catch (err) {
      if (err instanceof DeviceAlreadyLinkedError) {
        return res.status(409).json({ error: err.message, code: err.code });
      }
      console.error('equipment.routes PATCH /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error actualizando equipo estático' });
    }
  });

  router.patch('/:id/status', async (req, res) => {
    try {
      const { status } = req.body;
      const eq = await equipmentRepo.updateStatus(Number(req.params.id), status);
      if (!eq) return res.status(404).json({ error: 'Equipo no encontrado' });
      equipmentManager.updateStatus(Number(req.params.id), status);
      broadcastEquipmentUpdate(eq.project_id);
      res.json(eq);
    } catch (err) {
      console.error('equipment.routes PATCH /:id/status:', (err as Error).message);
      res.status(500).json({ error: 'Error actualizando estado' });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const projectId = equipmentManager.equipment[id]?.projectId ?? null;
      await equipmentRepo.delete(id);
      equipmentManager.clearEquipment(id);
      broadcastEquipmentUpdate(projectId);
      res.json({ success: true });
    } catch (err) {
      console.error('equipment.routes DELETE /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error eliminando equipo' });
    }
  });

  return router;
}

export default buildEquipmentRouter;
