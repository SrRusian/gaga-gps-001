import type { Server, Socket } from 'socket.io';
import { ADMIN_ROOM, projectRoom } from '../api/middleware/auth.middleware';
import type { AuthTokenPayload } from '../api/middleware/auth.middleware';
import type AlertEventRepository from '../repositories/AlertEventRepository';
import type { AlertEventRow } from '../repositories/AlertEventRepository';
import type MapRepository from '../repositories/MapRepository';
import type GeofenceAlertService from '../services/alerts/GeofenceAlertService';
import type IncidentAlertService from '../services/alerts/IncidentAlertService';
import { toPublicShape as incidentPublicShape } from '../services/alerts/IncidentAlertService';
import type PreventiveStopService from '../services/alerts/PreventiveStopService';
import type StaticEquipmentManager from '../services/static_equipment/StaticEquipmentManager';
import { toPublicShape } from '../services/maps/mapShape';
import type FleetStateManager from '../services/telemetry/FleetStateManager';

export interface FleetSocketServerDeps {
  io: Server;
  fleetState: FleetStateManager;
  geofenceService?: GeofenceAlertService;
  preventiveStopService?: PreventiveStopService;
  mapRepo?: MapRepository;
  alertEventRepo?: AlertEventRepository;
  equipmentManager?: StaticEquipmentManager;
}

// cuarto de socket por tableta (deviceId), aparte de los de rol/proyecto - unico lugar donde el
// backend puede mandarle un evento a UNA tableta en concreto (ver sendToDevice/force-update)
export function deviceRoom(deviceId: string): string {
  return `device:${deviceId}`;
}

function alertEventKey(row: AlertEventRow): string {
  switch (row.alert_type) {
    case 'geofence':
      return `geofence:${row.device_id}`;
    case 'signal_lost':
      return `signal:${row.device_id}`;
    // deviceId es string, no numérico - sort().join() en vez de Math.min (bug real ya corregido)
    case 'collision':
      return `collision:${[row.device_id, row.device_id_2].sort().join('-')}`;
    case 'proximity':
      return `proximity:${[row.device_id, row.device_id_2].sort().join('-')}`;
    case 'preventive_stop':
      return 'preventive_stop';
    default:
      return `${row.alert_type}:${row.id}`;
  }
}

class FleetSocketServer {
  io: Server;
  fleetState: FleetStateManager;
  geofenceService?: GeofenceAlertService;
  preventiveStopService?: PreventiveStopService;
  mapRepo?: MapRepository;
  alertEventRepo?: AlertEventRepository;
  equipmentManager?: StaticEquipmentManager;
  incidentAlertService?: IncidentAlertService; // asignado post-construcción desde app.ts, evita ciclo

  constructor({
    io,
    fleetState,
    geofenceService,
    preventiveStopService,
    mapRepo,
    alertEventRepo,
    equipmentManager,
  }: FleetSocketServerDeps) {
    this.io = io;
    this.fleetState = fleetState;
    this.geofenceService = geofenceService;
    this.preventiveStopService = preventiveStopService;
    this.mapRepo = mapRepo;
    this.alertEventRepo = alertEventRepo;
    this.equipmentManager = equipmentManager;

    this._registerConnectionHandler();
  }

  _registerConnectionHandler(): void {
    // hidratación filtrada por proyecto - no solo los broadcasts en vivo
    this.io.on('connection', async (socket: Socket) => {
      console.log(`Cliente conectado: ${socket.id}`);
      const user = (socket.data as { user?: AuthTokenPayload }).user;

      try {
        const currentFleet = await this.fleetState.getAll();
        const visible =
          user?.role === 'admin'
            ? Object.values(currentFleet)
            : Object.values(currentFleet).filter((p) => p.projectId === user?.projectId);

        if (visible.length > 0) {
          socket.emit('fleet:update', {
            positions: visible,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.error('FleetSocketServer - error hidratando flota:', (err as Error).message);
      }

      if (this.equipmentManager) {
        const allEquipment = Object.values(this.equipmentManager.equipment);
        const visibleEquipment =
          user?.role === 'admin'
            ? allEquipment
            : allEquipment.filter((eq) => eq.projectId === user?.projectId);
        if (visibleEquipment.length > 0) {
          socket.emit('equipment:update', visibleEquipment);
        }
      }

      if (this.geofenceService) {
        const visibleGeofences =
          user?.role === 'admin'
            ? this.geofenceService.activeGeofences
            : this.geofenceService.activeGeofences.filter((g) => g.projectId === user?.projectId);
        socket.emit('geofences:update', visibleGeofences);

        const activeAlerts = this.geofenceService.getActiveAlerts();
        Object.entries(activeAlerts).forEach(([deviceId, severity]) => {
          if (severity === 'danger') {
            socket.emit('alert:critical', {
              type: 'geofence_red',
              deviceId,
              message: 'PELIGRO - DETENER VEHÍCULO INMEDIATAMENTE',
              loop: true,
              timestamp: new Date().toISOString(),
            });
          } else if (severity === 'warning') {
            socket.emit('alert:warning', {
              type: 'geofence_yellow',
              deviceId,
              message: 'PRECAUCIÓN - ZONA DE RIESGO - REDUCIR VELOCIDAD',
              timestamp: new Date().toISOString(),
            });
          }
        });
      }

      if (this.preventiveStopService) {
        const stopStatus = this.preventiveStopService.getStatus();
        if (stopStatus.isActive) {
          socket.emit('fleet:preventive_stop', {
            active: true,
            reason: stopStatus.reason,
            message:
              'ALTO TOTAL - DETENGA EL VEHÍCULO INMEDIATAMENTE Y REPORTE A CENTRAL POR RADIO',
            loop: true,
            timestamp: new Date().toISOString(),
          });
        }
      }

      if (this.incidentAlertService) {
        const incidents = Object.values(this.incidentAlertService.activeIncidents).filter(
          (inc) => user?.role === 'admin' || inc.project_id === user?.projectId,
        );
        incidents.forEach((inc) => {
          const payload = incidentPublicShape(inc);
          socket.emit('incident:reported', payload);
          socket.emit('supervisor:incident', { ...payload, level: 1 });
        });
      }

      if (this.alertEventRepo) {
        try {
          const projectId = user?.role === 'admin' ? null : (user?.projectId ?? null);
          const rows = (await this.alertEventRepo.findActive(projectId)).filter(
            (row) => row.alert_type !== 'incident',
          );
          if (rows.length > 0) {
            socket.emit(
              'alerts:snapshot',
              rows.map((row) => ({
                key: alertEventKey(row),
                message: row.message ?? '',
                severity: row.severity,
                triggeredAt: row.triggered_at.toString(),
              })),
            );
          }
        } catch (err) {
          console.error(
            'FleetSocketServer - error hidratando alerts:snapshot:',
            (err as Error).message,
          );
        }
      }

      if (this.mapRepo) {
        try {
          const mapsProjectId = user?.role === 'admin' ? null : (user?.projectId ?? null);
          const maps = await this.mapRepo.findActiveReady(mapsProjectId);
          socket.emit('maps:active_update', { maps: maps.map(toPublicShape) });
        } catch (err) {
          console.error(
            'FleetSocketServer - error hidratando mapas activos:',
            (err as Error).message,
          );
        }
      }

      // el Operador manda su propio deviceId apenas conecta (useOperatorSocket.ts) - unico dato
      // que permite dirigir un evento a esta tableta en particular (ver sendToDevice abajo)
      socket.on('device:hello', ({ deviceId }: { deviceId?: string }) => {
        if (deviceId) socket.join(deviceRoom(deviceId));
      });

      socket.on('disconnect', () => {
        console.log(`Cliente desconectado: ${socket.id}`);
      });
    });
  }

  broadcast(event: string, payload: unknown): void {
    this.io.emit(event, payload);
  }

  broadcastToProject(projectId: number | null, event: string, payload: unknown): void {
    if (projectId === null) {
      this.io.to(ADMIN_ROOM).emit(event, payload);
      return;
    }
    this.io.to(projectRoom(projectId)).to(ADMIN_ROOM).emit(event, payload);
  }

  // solo llega si esa tableta tiene la app abierta con el socket conectado en este momento (ver
  // "device:hello" arriba) - una tableta apagada/sin datos moviles lo recibe hasta que vuelva a
  // conectar, no antes; para eso sigue el chequeo periodico normal (ver update/UpdateScheduler.kt)
  sendToDevice(deviceId: string, event: string, payload: unknown): void {
    this.io.to(deviceRoom(deviceId)).emit(event, payload);
  }

  // como broadcastToProject, pero sin mandarselo a excludeDeviceId - para avisos de "otro vehiculo
  // de tu proyecto tiene un problema" que no le hacen sentido dirigidos a el mismo (ver
  // SignalLostService, que ademas manda por separado un aviso en primera persona a excludeDeviceId
  // via sendToDevice)
  broadcastToProjectExceptDevice(
    projectId: number | null,
    excludeDeviceId: string,
    event: string,
    payload: unknown,
  ): void {
    const target =
      projectId === null
        ? this.io.to(ADMIN_ROOM)
        : this.io.to(projectRoom(projectId)).to(ADMIN_ROOM);
    target.except(deviceRoom(excludeDeviceId)).emit(event, payload);
  }
}

export default FleetSocketServer;
