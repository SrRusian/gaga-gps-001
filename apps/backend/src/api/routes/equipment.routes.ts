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
import type EquipmentRepository from '../../repositories/EquipmentRepository';
import type StaticEquipmentManager from '../../services/static_equipment/StaticEquipmentManager';

interface SocketServerLike {
  broadcast(event: string, payload: unknown): void;
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

  router.get('/', async (req, res) => {
    try {
      const equipment = await equipmentRepo.findAll();
      res.json(equipment);
    } catch (err) {
      console.error('❌ equipment.routes GET /:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo equipo estático' });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { name, type, latitude, longitude, swingRadius, safetyRadius, status } = req.body;
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

      const eq = await equipmentRepo.create({
        name,
        type,
        latitude,
        longitude,
        swingRadius,
        safetyRadius,
        status,
      });

      equipmentManager.registerEquipment({
        id: eq.id,
        name: eq.name,
        type: eq.type,
        lat: eq.latitude,
        lon: eq.longitude,
        swingRadius: eq.swing_radius,
        safetyRadius: eq.safety_radius,
        status: eq.status,
      });

      socketServer.broadcast('equipment:update', Object.values(equipmentManager.equipment));
      res.status(201).json(eq);
    } catch (err) {
      console.error('❌ equipment.routes POST /:', (err as Error).message);
      res.status(500).json({ error: 'Error creando equipo estático' });
    }
  });

  router.patch('/:id/status', async (req, res) => {
    try {
      const { status } = req.body;
      const eq = await equipmentRepo.updateStatus(Number(req.params.id), status);
      if (!eq) return res.status(404).json({ error: 'Equipo no encontrado' });
      equipmentManager.updateStatus(Number(req.params.id), status);
      res.json(eq);
    } catch (err) {
      console.error('❌ equipment.routes PATCH /:id/status:', (err as Error).message);
      res.status(500).json({ error: 'Error actualizando estado' });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      await equipmentRepo.delete(Number(req.params.id));
      delete equipmentManager.equipment[Number(req.params.id)];
      socketServer.broadcast('equipment:update', Object.values(equipmentManager.equipment));
      res.json({ success: true });
    } catch (err) {
      console.error('❌ equipment.routes DELETE /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error eliminando equipo' });
    }
  });

  return router;
}

export default buildEquipmentRouter;
