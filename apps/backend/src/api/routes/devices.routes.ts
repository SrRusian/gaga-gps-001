/**
 * devices.routes.ts
 *
 * CRUD completo de dispositivos (tabletas) en PostgreSQL.
 * Reemplaza la gestión de dispositivos del panel de Traccar.
 *
 * `/lookup/:uniqueId` es público (sin JWT) - lo consulta la
 * pantalla de configuración de ui-operator para validar el
 * dispositivo ANTES de pedir login, evitando que un ID inventado
 * o mal tecleado avance hasta el flujo de turno.
 */
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
import type IncidentAlertService from '../../services/alerts/IncidentAlertService';
import type StaticEquipmentManager from '../../services/static_equipment/StaticEquipmentManager';
import type EquipmentRepository from '../../repositories/EquipmentRepository';

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
  incidentAlertService?: IncidentAlertService;
  equipmentRepo?: EquipmentRepository;
  equipmentManager?: StaticEquipmentManager;
  socketServer?: SocketServerLike;
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
  incidentAlertService,
  equipmentRepo,
  equipmentManager,
  socketServer,
}: DevicesRouterDeps) {
  const router = express.Router();

  router.get('/lookup/:uniqueId', async (req, res) => {
    try {
      const device = await deviceRepo.findByUniqueId(req.params.uniqueId);
      if (!device) return res.json({ exists: false });

      const activeSession = operatorSessionRepo
        ? await operatorSessionRepo.findActiveByDevice(req.params.uniqueId)
        : null;

      // Visible incluso antes de iniciar sesión - así la pantalla de
      // configuración de la tableta ya sabe "esto opera equipo X"
      // desde el primer momento, no solo después de /start.
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

  // Crear dispositivos nuevos es exclusivo del Admin global - un
  // Encargado de Proyecto puede editar/deshabilitar los de su
  // proyecto, pero no da de alta equipo nuevo (ver plan de roles).
  router.post('/', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
      const { uniqueId, name, type, projectId, attributes } = req.body;
      if (!uniqueId || !name) {
        return res.status(400).json({ error: 'uniqueId y name son requeridos' });
      }
      const device = await deviceRepo.create({ uniqueId, name, type, projectId, attributes });
      res.status(201).json(device);
    } catch (err) {
      console.error('devices.routes POST /:', (err as Error).message);
      res.status(500).json({ error: 'Error creando dispositivo' });
    }
  });

  // Editar (nombre/tipo) es exclusivo de Admin/Encargado - un
  // Supervisor de Proyecto solo observa la flota en vivo, nunca la
  // modifica (antes esta ruta solo exigía sesión válida, sin
  // restricción de rol - cualquier rol autenticado, incluido
  // Supervisor u Operador, podía renombrar un dispositivo por API
  // directa aunque ningún panel expusiera el botón).
  router.patch('/:id', authMiddleware, requireRole('admin', 'project_manager'), async (req, res) => {
    try {
      const existing = await deviceRepo.findById(Number(req.params.id));
      if (!existing) return res.status(404).json({ error: 'Dispositivo no encontrado' });
      if (req.user!.projectId != null && existing.project_id !== req.user!.projectId) {
        return res.status(404).json({ error: 'Dispositivo no encontrado' });
      }

      const { name, type, attributes } = req.body;
      // Reasignar de proyecto es exclusivo del Admin global.
      const projectId = req.user!.role === 'admin' ? req.body.projectId : undefined;
      const device = await deviceRepo.update(Number(req.params.id), {
        name,
        type,
        projectId,
        attributes,
      });
      res.json(device);
    } catch (err) {
      console.error('devices.routes PATCH /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error actualizando dispositivo' });
    }
  });

  router.delete('/:id', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
      // Se resuelve el unique_id ANTES de borrar - es la clave que
      // usa Redis (última posición conocida) y la que identifica al
      // dispositivo en el estado en memoria de los servicios de
      // alerta, distinta al id numérico de PostgreSQL usado en la URL.
      const device = await deviceRepo.findById(Number(req.params.id));

      // Los demás dispositivos conocidos hacen falta para limpiar
      // colisión/proximidad (alertas por PAR) - se toman ANTES de
      // eliminar este, no después.
      const otherDeviceIds = device
        ? (await deviceRepo.findAll())
            .filter((d) => d.id !== device.id)
            .map((d) => d.unique_id)
        : [];

      // Los incidentes abiertos de este dispositivo se resuelven
      // ANTES de deviceRepo.delete() - resolve() hace un UPDATE que
      // necesita que la fila de incident_reports todavía exista; si
      // se llamara después de purgada, no limpiaría ni el estado en
      // memoria ni avisaría en vivo a Supervisor (ver
      // IncidentAlertService.resolveDeviceIncidents).
      if (device && incidentAlertService) {
        await incidentAlertService.resolveDeviceIncidents(device.unique_id);
      }

      // ?force=true purga también el historial de posiciones -
      // acción destructiva explícita, no es el comportamiento
      // por defecto (se preserva el historial para auditoría).
      const force = req.query.force === 'true';
      await deviceRepo.delete(Number(req.params.id), { force });

      // Un dispositivo eliminado de PostgreSQL no debe seguir
      // "vivo" en el mapa - Redis solo cachea la última posición
      // conocida y nunca expira sola, así que hay que limpiarla
      // explícitamente para no dejar dispositivos fantasma que ya
      // no existen en la base de datos.
      if (fleetState && device) {
        await fleetState.remove(device.unique_id);
      }

      // Cualquier otra alerta activa (geocerca/señal perdida/colisión/
      // proximidad) también debe resolverse en vivo - sin esto, el
      // estado en memoria de cada servicio queda "fantasma" para
      // siempre (solo se limpia normalmente cuando el dispositivo
      // vuelve a reportar, y uno eliminado nunca lo hará), y un
      // Supervisor ya conectado seguiría viendo una alerta activa de
      // un vehículo que ya no existe.
      if (device) {
        geofenceAlertService?.clearDevice(device.unique_id, device.project_id);
        signalLostService?.clearDevice(device.unique_id);
        collisionRiskService?.clearDevice(device.unique_id, otherDeviceIds);
        vehicleProximityService?.clearDevice(device.unique_id, otherDeviceIds);

        // La FK de linked_device_id ya limpia la columna en Postgres
        // (ON DELETE SET NULL), pero el mapa en memoria de
        // equipmentManager no se entera solo - si esta tableta estaba
        // vinculada a un equipo, desvincularla ahí también y avisar
        // en vivo (mismo criterio que el resto de esta limpieza).
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
