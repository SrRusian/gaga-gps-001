import type { Position } from '@gaga-gps/shared-types';
import type PositionRepository from '../../repositories/PositionRepository';
import type ActivityClassificationService from './ActivityClassificationService';
import type CollisionRiskService from '../alerts/CollisionRiskService';
import type GeofenceAlertService from '../alerts/GeofenceAlertService';
import type IncidentAlertService from '../alerts/IncidentAlertService';
import type SignalLostService from '../alerts/SignalLostService';
import type SpeedAlertService from '../alerts/SpeedAlertService';
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
  speedAlertService?: SpeedAlertService;
  activityClassificationService?: ActivityClassificationService;
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
  speedAlertService?: SpeedAlertService;
  activityClassificationService?: ActivityClassificationService;

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
    speedAlertService,
    activityClassificationService,
  }: PositionProcessorDeps) {
    this.positionRepo = positionRepo;
    this.fleetState = fleetState;
    this.socketServer = socketServer;
    this.deviceManager = deviceManager;

    this.geofenceService = geofenceService;
    this.signalLostService = signalLostService;
    this.collisionService = collisionService;
    this.proximityService = proximityService;
    this.incidentAlertService = incidentAlertService;
    this.equipmentManager = equipmentManager;

    this.positionFilter = positionFilter;
    this.speedEstimator = speedEstimator;
    this.speedAlertService = speedAlertService;
    this.activityClassificationService = activityClassificationService;
  }

  async process(position: Position): Promise<Position> {
    try {
      if (this.deviceManager) {
        const device = await this.deviceManager.ensureRegistered(position.deviceId);
        await this.deviceManager.markOnline(position.deviceId, position.fixTime as Date);

        if (device) {
          position.deviceName = device.name;
          position.deviceType = device.type;
          position.projectId = device.project_id;
        }
      }

      if (this.signalLostService) {
        this.signalLostService.recordPosition(position.deviceId, position.projectId ?? null);
      }

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

      await this.positionRepo.save(position);

      await this.fleetState.update(position);

      let geofenceMatches: Awaited<ReturnType<GeofenceAlertService['evaluate']>> = [];
      if (this.geofenceService) {
        geofenceMatches = await this.geofenceService.evaluate({
          ...position,
          projectId: position.projectId ?? null,
        });
      }

      if (this.speedAlertService) {
        await this.speedAlertService.evaluate({
          deviceId: position.deviceId,
          speedKmh: (position.speed ?? 0) * 3.6,
          projectId: position.projectId ?? null,
          geofenceMatches,
        });
      }

      if (this.activityClassificationService) {
        await this.activityClassificationService.evaluate({
          deviceId: position.deviceId,
          speedKmh: (position.speed ?? 0) * 3.6,
          timestamp: new Date(position.fixTime).getTime(),
        });
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
