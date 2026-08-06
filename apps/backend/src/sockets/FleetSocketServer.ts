/**
 * FleetSocketServer.ts
 *
 * Responsabilidad: Encapsular Socket.io — maneja conexiones
 * entrantes, hidrata a cada cliente nuevo con el estado actual
 * (flota, geocercas, alertas activas, parada preventiva, capas de
 * mapas satelitales activas) y expone broadcast() para que otros
 * servicios distribuyan eventos sin acoplarse directamente a `io`.
 */
import type { Server, Socket } from 'socket.io';
import type MapRepository from '../repositories/MapRepository';
import type GeofenceAlertService from '../services/alerts/GeofenceAlertService';
import type PreventiveStopService from '../services/alerts/PreventiveStopService';
import { toPublicShape } from '../services/maps/mapShape';
import type FleetStateManager from '../services/telemetry/FleetStateManager';

export interface FleetSocketServerDeps {
  io: Server;
  fleetState: FleetStateManager;
  geofenceService?: GeofenceAlertService;
  preventiveStopService?: PreventiveStopService;
  mapRepo?: MapRepository;
}

class FleetSocketServer {
  io: Server;
  fleetState: FleetStateManager;
  geofenceService?: GeofenceAlertService;
  preventiveStopService?: PreventiveStopService;
  mapRepo?: MapRepository;

  constructor({
    io,
    fleetState,
    geofenceService,
    preventiveStopService,
    mapRepo,
  }: FleetSocketServerDeps) {
    this.io = io;
    this.fleetState = fleetState;
    this.geofenceService = geofenceService;
    this.preventiveStopService = preventiveStopService;
    this.mapRepo = mapRepo;

    this._registerConnectionHandler();
  }

  _registerConnectionHandler(): void {
    this.io.on('connection', async (socket: Socket) => {
      console.log(`✅ Cliente conectado: ${socket.id}`);

      // Hidratar con el estado actual de la flota (Redis)
      try {
        const currentFleet = await this.fleetState.getAll();
        if (Object.keys(currentFleet).length > 0) {
          socket.emit('fleet:update', {
            positions: Object.values(currentFleet),
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.error('❌ FleetSocketServer — error hidratando flota:', (err as Error).message);
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
              message: 'PELIGRO — DETENER VEHÍCULO INMEDIATAMENTE',
              loop: true,
              timestamp: new Date().toISOString(),
            });
          } else if (severity === 'warning') {
            socket.emit('alert:warning', {
              type: 'geofence_yellow',
              deviceId,
              message: 'PRECAUCIÓN — ZONA DE RIESGO — REDUCIR VELOCIDAD',
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
              'ALTO TOTAL — DETENGA EL VEHÍCULO INMEDIATAMENTE Y REPORTE A CENTRAL POR RADIO',
            loop: true,
            timestamp: new Date().toISOString(),
          });
        }
      }

      // Capas de mapas satelitales activas
      if (this.mapRepo) {
        try {
          const maps = await this.mapRepo.findActiveReady();
          socket.emit('maps:active_update', { maps: maps.map(toPublicShape) });
        } catch (err) {
          console.error(
            '❌ FleetSocketServer — error hidratando mapas activos:',
            (err as Error).message,
          );
        }
      }

      socket.on('disconnect', () => {
        console.log(`❌ Cliente desconectado: ${socket.id}`);
      });
    });
  }

  /**
   * Distribuye un evento a todos los clientes conectados
   */
  broadcast(event: string, payload: unknown): void {
    this.io.emit(event, payload);
  }
}

export default FleetSocketServer;
