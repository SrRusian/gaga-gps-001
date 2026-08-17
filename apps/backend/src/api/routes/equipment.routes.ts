/**
 * equipment.routes.ts
 *
 * CRUD de equipo estático (palas, excavadoras, cargadores) con
 * radio de giro. Persiste en PostgreSQL y sincroniza con
 * StaticEquipmentManager (memoria) para evaluación en tiempo real.
 *
 * RF asociados: RF-ALR-12
 */
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

  // Reenvía el snapshot completo del equipo de UN proyecto (mismo
  // criterio "reenviar todo" que ya usaba geofences:update) - nunca
  // el mapa global completo, para no filtrar equipo de otros
  // proyectos a quien no debe verlo (broadcastToProject ya limita la
  // sala, pero el payload también debe estar acotado).
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

  // Edición completa (posición/radios/nombre/tipo) - distinta de
  // /:id/status, que solo maneja el ciclo activo/pausa/inactivo.
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
        // `linkedDeviceId` solo se toca si la key vino en el body -
        // `undefined` (no vino) deja el vínculo actual intacto,
        // `null` explícito lo desvincula (ver EquipmentRepository.update).
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
      // Capturar el proyecto ANTES de borrar - una vez eliminado de
      // `equipmentManager.equipment` no hay forma de saber a qué sala
      // avisar.
      const projectId = equipmentManager.equipment[id]?.projectId ?? null;
      await equipmentRepo.delete(id);
      // clearEquipment (no un simple delete) - también libera a
      // cualquier vehículo que siguiera en zona de alerta contra este
      // equipo, ver StaticEquipmentManager. El dispositivo vinculado
      // (si tenía uno) no se toca - la FK ya lo hizo NULL en Postgres,
      // el dispositivo en sí nunca se elimina.
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
