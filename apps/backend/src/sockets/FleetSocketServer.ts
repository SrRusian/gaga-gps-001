/**
 * FleetSocketServer.ts
 *
 * Responsabilidad: Encapsular Socket.io - maneja conexiones
 * entrantes, hidrata a cada cliente nuevo con el estado actual
 * (flota, geocercas, alertas activas, parada preventiva, capas de
 * mapas satelitales activas) y expone broadcast() para que otros
 * servicios distribuyan eventos sin acoplarse directamente a `io`.
 */
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

/**
 * Arma la misma clave que ya usa `useSupervisorSocket.ts` para
 * upsert/resolve en vivo (`geofence:${deviceId}`, `pairKey('collision', ...)`,
 * etc.) - así una fila rehidratada desde `alert_events` y una que
 * llega después por un evento `supervisor:*` en vivo apuntan a la
 * MISMA entrada en `activeAlerts`, no a dos duplicadas.
 */
function alertEventKey(row: AlertEventRow): string {
  switch (row.alert_type) {
    case 'geofence':
      return `geofence:${row.device_id}`;
    case 'signal_lost':
      return `signal:${row.device_id}`;
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
  // Asignado después de construir (IncidentAlertService necesita
  // esta misma instancia para emitir, así que no puede llegar por
  // el constructor sin crear una dependencia circular) - ver app.ts.
  incidentAlertService?: IncidentAlertService;

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
    this.io.on('connection', async (socket: Socket) => {
      console.log(`Cliente conectado: ${socket.id}`);
      const user = (socket.data as { user?: AuthTokenPayload }).user;

      // Hidratar con el estado actual de la flota (Redis) - filtrado
      // al proyecto del usuario conectado; un admin (projectId null)
      // recibe todo. Sin este filtro, el snapshot inicial (a
      // diferencia de las actualizaciones en vivo, que ya van solo a
      // la sala de su proyecto) filtraría toda la flota a cualquiera.
      try {
        const currentFleet = await this.fleetState.getAll();
        // Solo el admin global ve la flota completa sin filtrar -
        // un rol de proyecto mal configurado (projectId null sin ser
        // admin) no debe heredar esa vista por accidente.
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

      // Equipo estático - filtrado por proyecto (solo admin ve todo),
      // mismo criterio que la flota de arriba. A diferencia de
      // geofences:update (que se reenvía sin filtrar - gap
      // preexistente, documentado, fuera del alcance de este cambio),
      // este es nuevo y se construye ya filtrado desde el día uno.
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

      // Geocercas activas
      if (this.geofenceService) {
        socket.emit('geofences:update', this.geofenceService.activeGeofences);

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

      // Estado de parada preventiva
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

      // Incidentes abiertos del proyecto - mismo filtro que la flota:
      // solo Admin ve todos, un rol de proyecto solo los del suyo.
      // Se emiten AMBOS eventos, no solo `incident:reported`: ese
      // alimenta el marcador del mapa (`incidentMarkers` en
      // useSupervisorSocket), pero la lista "Alertas activas" depende
      // de `supervisor:incident` - sin esto, un Supervisor que
      // recarga la página pierde de la lista cualquier incidente ya
      // reportado antes de conectarse (aunque el marcador del mapa
      // siga viéndose bien, por eso el bug pasaba desapercibido).
      if (this.incidentAlertService) {
        const incidents = Object.values(this.incidentAlertService.activeIncidents).filter(
          (inc) => user?.role === 'admin' || inc.project_id === user?.projectId,
        );
        incidents.forEach((inc) => {
          // Reutiliza el mismo armado de forma pública que usa
          // IncidentAlertService al reportar/resolver - evita repetir
          // (y volver a desalinear) la normalización BIGSERIAL→Number
          // del `id` en un segundo lugar (ver CLAUDE.md).
          const payload = incidentPublicShape(inc);
          socket.emit('incident:reported', payload);
          socket.emit('supervisor:incident', { ...payload, level: 1 });
        });
      }

      // Historial de alertas "normales" (geocerca, señal perdida,
      // colisión, proximidad, parada preventiva) - sin esto, un
      // Supervisor que recarga la página pierde de "Alertas activas"
      // cualquiera que ya estuviera abierta antes de conectarse
      // (mismo bug que ya se corrigió para incidentes, generalizado
      // aquí a las otras 5 familias vía `alert_events`). Se excluye
      // 'incident' - ese ya se hidrata arriba con su propio evento.
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

      // Capas de mapas satelitales activas - acotadas al proyecto del
      // usuario conectado, mismo criterio que el resto de la
      // hidratación (admin: sin filtrar).
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

      socket.on('disconnect', () => {
        console.log(`Cliente desconectado: ${socket.id}`);
      });
    });
  }

  /**
   * Distribuye un evento a todos los clientes conectados -
   * reservado para eventos verdaderamente globales (p. ej. mapas
   * satelitales activos). Para lo que sea específico de la flota de
   * un proyecto, usar broadcastToProject.
   */
  broadcast(event: string, payload: unknown): void {
    this.io.emit(event, payload);
  }

  /**
   * Distribuye un evento solo a la sala del proyecto indicado (+ la
   * sala de admins, que recibe todo) - así un cliente de otro
   * proyecto nunca lo recibe. `projectId = null` es la sala de
   * dispositivos sin proyecto asignado todavía; solo los admins la
   * ven (nadie más se une a esa sala).
   */
  broadcastToProject(projectId: number | null, event: string, payload: unknown): void {
    if (projectId === null) {
      this.io.to(ADMIN_ROOM).emit(event, payload);
      return;
    }
    this.io.to(projectRoom(projectId)).to(ADMIN_ROOM).emit(event, payload);
  }
}

export default FleetSocketServer;
