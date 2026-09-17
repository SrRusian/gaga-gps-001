import type { Position } from '@gaga-gps/shared-types';
import type PositionRepository from '../../repositories/PositionRepository';
import { buildVehicleFootprintWkt, VehicleHeadingTracker } from '../../utils/vehicleFootprint';
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

interface DeviceFootprintRepoLike {
  findAlertContext(deviceId: string): Promise<{
    lengthMeters: number | null;
    widthMeters: number | null;
  }>;
}

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
  // solo para el rectangulo de deteccion de proximidad a geocercas peligrosas (largo/ancho reales
  // del tipo de vehiculo) - ver backend/src/utils/vehicleFootprint.ts
  deviceFootprintRepo?: DeviceFootprintRepoLike;
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
  deviceFootprintRepo?: DeviceFootprintRepoLike;
  headingTracker: VehicleHeadingTracker;

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
    deviceFootprintRepo,
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
    this.deviceFootprintRepo = deviceFootprintRepo;
    this.headingTracker = new VehicleHeadingTracker();
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

      // rectangulo orientado real del vehiculo (Parte B - proximidad elastica a geocercas
      // peligrosas), solo si el dispositivo tiene tipo de vehiculo asignado y un rumbo confiable
      // reciente - si cualquiera de los dos falta, footprintWkt queda null y el resto del flujo
      // sigue exactamente igual que antes de esta feature (punto crudo, sin buffer)
      let footprintWkt: string | null = null;
      if (this.deviceFootprintRepo) {
        try {
          const { lengthMeters, widthMeters } = await this.deviceFootprintRepo.findAlertContext(
            position.deviceId,
          );
          const speedKmhForHeading = (position.speed ?? 0) * 3.6;
          const trustedCourse = this.headingTracker.resolveTrustedCourse(
            position.deviceId,
            position.course,
            speedKmhForHeading,
          );
          if (lengthMeters != null && widthMeters != null && trustedCourse != null) {
            footprintWkt = buildVehicleFootprintWkt(
              position.latitude,
              position.longitude,
              trustedCourse,
              lengthMeters,
              widthMeters,
            );
          }
        } catch (err) {
          console.error('PositionProcessor - error construyendo footprint del vehiculo:', (err as Error).message);
        }
      }

      let geofenceMatches: Awaited<ReturnType<GeofenceAlertService['evaluate']>> = [];
      if (this.geofenceService) {
        geofenceMatches = await this.geofenceService.evaluate({
          ...position,
          projectId: position.projectId ?? null,
          footprintWkt,
          accuracy: position.accuracy ?? 0,
        });
      }

      if (this.speedAlertService) {
        await this.speedAlertService.evaluate({
          deviceId: position.deviceId,
          speedKmh: (position.speed ?? 0) * 3.6,
          projectId: position.projectId ?? null,
          geofenceMatches,
          latitude: position.latitude,
          longitude: position.longitude,
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
        await this.collisionService.evaluate(
          { ...position, projectId: position.projectId ?? null, footprintWkt },
          fleet,
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
