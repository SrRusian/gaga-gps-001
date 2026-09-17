import type { RequestHandler } from 'express';
import express from 'express';
import DeviceRepository, { DeviceHasPositionsError } from '../../repositories/DeviceRepository';
import type OperatorSessionRepository from '../../repositories/OperatorSessionRepository';
import type { UserRole } from '../../repositories/UserRepository';
import type FleetStateManager from '../../services/telemetry/FleetStateManager';
import type GeofenceAlertService from '../../services/alerts/GeofenceAlertService';
import type SignalLostService from '../../services/alerts/SignalLostService';
import type CollisionRiskService from '../../services/alerts/CollisionRiskService';
import type VehicleProximityService from '../../services/alerts/VehicleProximityService';
import type SpeedAlertService from '../../services/alerts/SpeedAlertService';
import type ActivityClassificationService from '../../services/telemetry/ActivityClassificationService';
import type IncidentAlertService from '../../services/alerts/IncidentAlertService';
import type StaticEquipmentManager from '../../services/static_equipment/StaticEquipmentManager';
import type EquipmentRepository from '../../repositories/EquipmentRepository';
import type DeviceProjectHistoryRepository from '../../repositories/DeviceProjectHistoryRepository';

interface SocketServerLike {
  broadcastToProject(projectId: number | null, event: string, payload: unknown): void;
}

export interface DevicesRouterDeps {
  deviceRepo: DeviceRepository;
  operatorSessionRepo?: OperatorSessionRepository;
  authMiddleware: RequestHandler;
  requireRole: (...roles: UserRole[]) => RequestHandler;
  fleetState?: FleetStateManager;
  geofenceAlertService?: GeofenceAlertService;
  signalLostService?: SignalLostService;
  collisionRiskService?: CollisionRiskService;
  vehicleProximityService?: VehicleProximityService;
  speedAlertService?: SpeedAlertService;
  activityClassificationService?: ActivityClassificationService;
  incidentAlertService?: IncidentAlertService;
  equipmentRepo?: EquipmentRepository;
  equipmentManager?: StaticEquipmentManager;
  socketServer?: SocketServerLike;
  deviceProjectHistoryRepo?: DeviceProjectHistoryRepository;
}

export function buildDevicesRouter({
  deviceRepo,
  operatorSessionRepo,
  authMiddleware,
  requireRole,
  fleetState,
  geofenceAlertService,
  signalLostService,
  collisionRiskService,
  vehicleProximityService,
  speedAlertService,
  activityClassificationService,
  incidentAlertService,
  equipmentRepo,
  equipmentManager,
  socketServer,
  deviceProjectHistoryRepo,
}: DevicesRouterDeps) {
  const router = express.Router();

  router.get('/lookup/:uniqueId', async (req, res) => {
    try {
      const device = await deviceRepo.findByUniqueId(req.params.uniqueId);
      if (!device) return res.json({ exists: false });

      const activeSession = operatorSessionRepo
        ? await operatorSessionRepo.findActiveByDevice(req.params.uniqueId)
        : null;

      const equipment = equipmentRepo
        ? await equipmentRepo.findByLinkedDevice(req.params.uniqueId)
        : null;

      res.json({
        exists: true,
        name: device.name,
        type: device.type,
        activeSession: activeSession
          ? { userName: activeSession.user_name, startedAt: activeSession.started_at }
          : null,
        equipment: equipment
          ? {
              id: equipment.id,
              name: equipment.name,
              type: equipment.type,
              swingRadiusMeters: equipment.swing_radius,
              safetyRadiusMeters: equipment.safety_radius,
            }
          : null,
      });
    } catch (err) {
      console.error('devices.routes GET /lookup/:uniqueId:', (err as Error).message);
      res.status(500).json({ error: 'Error verificando dispositivo' });
    }
  });

  router.get('/', authMiddleware, async (req, res) => {
    try {
      const devices =
        req.user!.projectId != null
          ? await deviceRepo.findByProject(req.user!.projectId)
          : await deviceRepo.findAll();
      res.json(devices);
    } catch (err) {
      console.error('devices.routes GET /:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo dispositivos' });
    }
  });

  router.get('/:id', authMiddleware, async (req, res) => {
    try {
      const device = await deviceRepo.findById(Number(req.params.id));
      if (!device) return res.status(404).json({ error: 'Dispositivo no encontrado' });
      if (req.user!.projectId != null && device.project_id !== req.user!.projectId) {
        return res.status(404).json({ error: 'Dispositivo no encontrado' });
      }
      res.json(device);
    } catch (err) {
      console.error('devices.routes GET /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo dispositivo' });
    }
  });

  router.post('/', authMiddleware, requireRole('admin', 'project_administrator'), async (req, res) => {
    try {
      const { uniqueId, name, type, attributes, vehicleTypeId } = req.body;
      if (!uniqueId || !name) {
        return res.status(400).json({ error: 'uniqueId y name son requeridos' });
      }
      // no-admin nunca origina un dispositivo fuera de su propio proyecto
      const projectId = req.user!.role === 'admin' ? req.body.projectId : req.user!.projectId;
      const device = await deviceRepo.create({ uniqueId, name, type, projectId, vehicleTypeId, attributes });
      if (device.project_id != null) {
        await deviceProjectHistoryRepo?.recordChange({
          deviceId: device.unique_id,
          projectId: device.project_id,
          changedBy: req.user!.id,
        });
      }
      res.status(201).json(device);
    } catch (err) {
      console.error('devices.routes POST /:', (err as Error).message);
      res.status(500).json({ error: 'Error creando dispositivo' });
    }
  });

  router.patch('/:id', authMiddleware, requireRole('admin', 'project_administrator'), async (req, res) => {
    try {
      const existing = await deviceRepo.findById(Number(req.params.id));
      if (!existing) return res.status(404).json({ error: 'Dispositivo no encontrado' });
      if (req.user!.projectId != null && existing.project_id !== req.user!.projectId) {
        return res.status(404).json({ error: 'Dispositivo no encontrado' });
      }

      const { name, type, attributes, groupId, vehicleTypeId, speedLimitKmh } = req.body;
      const projectId = req.user!.role === 'admin' ? req.body.projectId : undefined;
      const device = await deviceRepo.update(Number(req.params.id), {
        name,
        type,
        projectId,
        attributes,
        groupId,
        vehicleTypeId,
        speedLimitKmh,
      });
      if (
        req.user!.role === 'admin' &&
        req.body.projectId !== undefined &&
        req.body.projectId !== existing.project_id &&
        device
      ) {
        await deviceProjectHistoryRepo?.recordChange({
          deviceId: device.unique_id,
          projectId: device.project_id,
          changedBy: req.user!.id,
        });
      }
      res.json(device);
    } catch (err) {
      console.error('devices.routes PATCH /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error actualizando dispositivo' });
    }
  });

  router.delete('/:id', authMiddleware, requireRole('admin', 'project_administrator'), async (req, res) => {
    try {
      const device = await deviceRepo.findById(Number(req.params.id));
      if (!device) return res.status(404).json({ error: 'Dispositivo no encontrado' });
      if (req.user!.projectId != null && device.project_id !== req.user!.projectId) {
        return res.status(404).json({ error: 'Dispositivo no encontrado' });
      }
      const otherDeviceIds = device
        ? (await deviceRepo.findAll())
            .filter((d) => d.id !== device.id)
            .map((d) => d.unique_id)
        : [];

      if (device && incidentAlertService) {
        // debe ir ANTES de purgar la fila - resolveDeviceIncidents necesita que exista todavía
        await incidentAlertService.resolveDeviceIncidents(device.unique_id);
      }

      const force = req.query.force === 'true';
      await deviceRepo.delete(Number(req.params.id), { force });

      if (fleetState && device) {
        await fleetState.remove(device.unique_id);
      }

      if (device) {
        // la fila ya no existe pero el estado en memoria de cada servicio de alerta sigue vivo
        geofenceAlertService?.clearDevice(device.unique_id, device.project_id);
        signalLostService?.clearDevice(device.unique_id);
        collisionRiskService?.clearDevice(device.unique_id, otherDeviceIds);
        vehicleProximityService?.clearDevice(device.unique_id, otherDeviceIds);
        speedAlertService?.clearDevice(device.unique_id, device.project_id);
        activityClassificationService?.clearDevice(device.unique_id);

        const unlinkedEquipment = equipmentManager?.clearDeviceLink(device.unique_id);
        if (unlinkedEquipment && socketServer && equipmentManager) {
          const scoped = Object.values(equipmentManager.equipment).filter(
            (eq) => eq.projectId === unlinkedEquipment.projectId,
          );
          socketServer.broadcastToProject(unlinkedEquipment.projectId, 'equipment:update', scoped);
        }
      }

      res.json({ success: true });
    } catch (err) {
      if (err instanceof DeviceHasPositionsError) {
        return res.status(409).json({
          error:
            'El dispositivo tiene posiciones y/o turnos de operador registrados - no se puede eliminar sin purgar su historial',
          code: err.code,
          hint: 'Reintente con ?force=true si desea eliminar también ese historial',
        });
      }
      console.error('devices.routes DELETE /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error eliminando dispositivo' });
    }
  });

  return router;
}

export default buildDevicesRouter;
