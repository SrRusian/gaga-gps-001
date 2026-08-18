/**
 * PositionProcessor.ts
 *
 * Responsabilidad: Procesar una posición entrante del receptor
 * OsmAnd (GET /gps) - reemplaza a TraccarWsClient.js.
 *
 * En lugar de recibir posiciones vía WebSocket de Traccar, este
 * servicio se invoca directamente desde telemetry.routes.js
 * cada vez que una tableta reporta su posición.
 *
 * Flujo:
 *   1. Filtrar saltos físicamente implausibles (PositionFilterService)
 *      - glitch RTK/NTRIP; si se rechaza, se persiste como inválida
 *      y el flujo termina ahí
 *   2. Persistir en PostgreSQL (PositionRepository)
 *   3. Actualizar estado en memoria/Redis (FleetStateManager)
 *   4. Ejecutar módulos de seguridad (sin modificar su lógica)
 *   5. Distribuir vía Socket.io (FleetSocketServer)
 *
 * RF asociados: RF-TEL-01, RF-TEL-02
 */
import type { Position } from '@gaga-gps/shared-types';
import type PositionRepository from '../../repositories/PositionRepository';
import type CollisionRiskService from '../alerts/CollisionRiskService';
import type GeofenceAlertService from '../alerts/GeofenceAlertService';
import type IncidentAlertService from '../alerts/IncidentAlertService';
import type SignalLostService from '../alerts/SignalLostService';
import type VehicleProximityService from '../alerts/VehicleProximityService';
import type StaticEquipmentManager from '../static_equipment/StaticEquipmentManager';
import type DeviceManager from './DeviceManager';
import type FleetStateManager from './FleetStateManager';
import type PositionFilterService from './PositionFilterService';
import type SpeedEstimationService from './SpeedEstimationService';

interface SocketServerLike {
  broadcast(event: string, payload: unknown): void;
  broadcastToProject(projectId: number | null, event: string, payload: unknown): void;
}

export interface PositionProcessorDeps {
  positionRepo: PositionRepository;
  fleetState: FleetStateManager;
  socketServer: SocketServerLike;
  deviceManager?: DeviceManager;
  geofenceService?: GeofenceAlertService;
  signalLostService?: SignalLostService;
  collisionService?: CollisionRiskService;
  proximityService?: VehicleProximityService;
  incidentAlertService?: IncidentAlertService;
  equipmentManager?: StaticEquipmentManager;
  positionFilter?: PositionFilterService;
  speedEstimator?: SpeedEstimationService;
}

class PositionProcessor {
  positionRepo: PositionRepository;
  fleetState: FleetStateManager;
  socketServer: SocketServerLike;
  deviceManager?: DeviceManager;
  geofenceService?: GeofenceAlertService;
  signalLostService?: SignalLostService;
  collisionService?: CollisionRiskService;
  proximityService?: VehicleProximityService;
  incidentAlertService?: IncidentAlertService;
  equipmentManager?: StaticEquipmentManager;
  positionFilter?: PositionFilterService;
  speedEstimator?: SpeedEstimationService;

  constructor({
    positionRepo,
    fleetState,
    socketServer,
    deviceManager,
    geofenceService,
    signalLostService,
    collisionService,
    proximityService,
    incidentAlertService,
    equipmentManager,
    positionFilter,
    speedEstimator,
  }: PositionProcessorDeps) {
    this.positionRepo = positionRepo;
    this.fleetState = fleetState;
    this.socketServer = socketServer;
    this.deviceManager = deviceManager;

    // Servicios de seguridad - los mismos usados antes por TraccarWsClient
    this.geofenceService = geofenceService;
    this.signalLostService = signalLostService;
    this.collisionService = collisionService;
    this.proximityService = proximityService;
    this.incidentAlertService = incidentAlertService;
    this.equipmentManager = equipmentManager;

    // Descarta "teletransportes" por glitch RTK/NTRIP antes de que
    // el punto llegue a Redis/alertas/mapa - opcional, si no se
    // inyecta el comportamiento es idéntico al de antes.
    this.positionFilter = positionFilter;
    this.speedEstimator = speedEstimator;
  }

  /**
   * Procesa una posición normalizada proveniente del endpoint /gps
   */
  async process(position: Position): Promise<Position> {
    try {
      // 1. Auto-registrar dispositivo y marcarlo online - corre
      // siempre, incluso si el fix resulta descartado más abajo:
      // el dispositivo sigue comunicándose, solo el dato de
      // posición es el que no es confiable.
      if (this.deviceManager) {
        const device = await this.deviceManager.ensureRegistered(position.deviceId);
        await this.deviceManager.markOnline(position.deviceId, position.fixTime as Date);

        // Se enriquece la posición con nombre/tipo del dispositivo
        // (p. ej. "Tableta", "Excavadora") para que Operador/Supervisor
        // muestren una etiqueta correcta sin tener que consultar la
        // API protegida de dispositivos - positionRepo.save() ignora
        // estos campos extra al insertar (solo lee los suyos).
        if (device) {
          position.deviceName = device.name;
          position.deviceType = device.type;
          position.projectId = device.project_id;
        }
      }

      if (this.signalLostService) {
        this.signalLostService.recordPosition(position.deviceId);
      }

      // 1.5 Filtro anti-teletransporte (glitch RTK/NTRIP) - compara
      // contra la última posición ACEPTADA del dispositivo. Si el
      // salto es físicamente implausible, se persiste marcado como
      // inválido (auditable) pero no toca Redis/alertas/mapa.
      if (this.positionFilter) {
        const verdict = this.positionFilter.evaluate(
          position as {
            deviceId: string;
            latitude: number;
            longitude: number;
            fixTime: Date | string | number;
          },
        );

        if (!verdict.accepted) {
          position.valid = false;
          position.attributes = {
            ...(position.attributes || {}),
            rejectReason: verdict.reason,
            impliedSpeedKmh: verdict.impliedSpeedKmh,
            allowedMaxKmh: verdict.allowedMaxKmh,
            distanceMeters: verdict.distanceMeters,
          };

          await this.positionRepo.save(position);

          console.warn(
            ` Posición descartada (${verdict.reason}) - Device: ${position.deviceId} | salto: ${verdict.distanceMeters?.toFixed(1)}m | vel. implícita: ${verdict.impliedSpeedKmh?.toFixed(1)}km/h (máx. permitido ${verdict.allowedMaxKmh?.toFixed(1)}km/h)`,
          );

          return position;
        }

        if (verdict.resynced) {
          console.warn(
            ` Device ${position.deviceId} resincronizado tras varios saltos consecutivos - vel. implícita ${verdict.impliedSpeedKmh?.toFixed(1)}km/h`,
          );
        }
      }

      // 1.6 Velocidad suavizada - SpeedEstimationService
      if (this.speedEstimator) {
        const fixTimeMs = new Date(position.fixTime).getTime();
        const estimate = this.speedEstimator.estimate(
          position.deviceId,
          position.latitude,
          position.longitude,
          fixTimeMs,
          position.speed,
        );
        position.attributes = {
          ...(position.attributes || {}),
          rawSpeedKmh: estimate.rawDeviceKmh ?? undefined,
        };
        position.speed = estimate.speedMs;
      }

      // 2. Persistir en PostgreSQL/TimescaleDB
      await this.positionRepo.save(position);

      // 3. Actualizar estado en memoria (Redis)
      await this.fleetState.update(position);

      // 4. Ejecutar módulos de seguridad - NO se modifican, solo se invocan
      if (this.geofenceService) {
        // Único await de este bloque - evaluate() consulta PostGIS
        // (un solo query indexado por project_id + geog). Los demás
        // servicios de abajo siguen síncronos/en memoria a propósito
        // (ver CLAUDE.md/plan - no tienen geometría guardada que
        // indexar, un round-trip extra ahí no aportaría nada).
        await this.geofenceService.evaluate({ ...position, projectId: position.projectId ?? null });
      }

      if (this.collisionService) {
        const fleet = await this.fleetState.getAll();
        this.collisionService.evaluate(
          position as unknown as { deviceId: number; latitude: number; longitude: number },
          fleet as unknown as Record<
            string,
            { deviceId: number; latitude: number; longitude: number }
          >,
        );
      }

      if (this.proximityService) {
        const fleet = await this.fleetState.getAll();
        this.proximityService.evaluate(position, fleet, this.geofenceService?.activeGeofences);
      }

      if (this.incidentAlertService) {
        this.incidentAlertService.evaluate(position);
      }

      if (this.equipmentManager) {
        this.equipmentManager.evaluate(position);
      }

      // 5. Distribuir a clientes conectados (operador/supervisor) -
      // solo a la sala del proyecto de este dispositivo (+ admins,
      // que reciben todo). Un dispositivo sin proyecto asignado
      // todavía (project_id null) no llega a ningún operador, solo
      // a Admin - evita que un dispositivo "huérfano" se filtre a
      // cualquier proyecto por accidente.
      this.socketServer.broadcastToProject(position.projectId ?? null, 'fleet:update', {
        positions: [position],
        timestamp: new Date().toISOString(),
      });

      console.log(
        `Posición procesada - Device: ${position.deviceId} | Lat: ${position.latitude} | Lon: ${position.longitude}`,
      );

      return position;
    } catch (err) {
      console.error('PositionProcessor.process:', (err as Error).message);
      throw err;
    }
  }
}

export default PositionProcessor;
