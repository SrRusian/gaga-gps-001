import type { Geofence } from '@gaga-gps/shared-types';
import { isInsideGeofence } from '../../utils/geometry';

interface SocketIoLike {
  emit(event: string, payload: unknown): void;
}

interface AlertEventRepoLike {
  recordOrEscalate(event: {
    alertType: 'proximity';
    severity: 'warning' | 'danger';
    deviceId: string;
    deviceId2: string;
    message?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<unknown>;
  resolveOpen(event: { alertType: 'proximity'; deviceId: string; deviceId2: string }): Promise<unknown>;
}

interface EvaluatedPosition {
  deviceId: string;
  latitude: number;
  longitude: number;
}

type ProximityAlertLevel = 'none' | 'warning' | 'critical';

// separado de CollisionRiskService a proposito, sin heuristica de convergencia
// global, no filtra por proyecto (gap de aislamiento conocido)
class VehicleProximityService {
  io: SocketIoLike;
  alertEventRepo?: AlertEventRepoLike;
  proximityAlerts: Record<string, ProximityAlertLevel>;
  readonly VISIBILITY_METERS = 150;
  readonly WARNING_METERS = 80;
  readonly CRITICAL_METERS = 35;

  constructor({ io, alertEventRepo }: { io: SocketIoLike; alertEventRepo?: AlertEventRepoLike }) {
    this.io = io;
    this.alertEventRepo = alertEventRepo;
    this.proximityAlerts = {};
  }

  evaluate(
    position: EvaluatedPosition,
    fleetState: Record<string, EvaluatedPosition>,
    activeGeofences: Geofence[] = [],
  ): void {
    const { deviceId } = position;
    if (this.isInsideAnyRoute(position, activeGeofences)) {
      return;
    }

    let nearest: { deviceId: string; distance: number } | null = null;

    Object.values(fleetState).forEach((otherPos) => {
      if (otherPos.deviceId === deviceId) return;
      if (this.isInsideAnyRoute(otherPos, activeGeofences)) return;

      const distance = this.calculateDistance(
        position.latitude,
        position.longitude,
        otherPos.latitude,
        otherPos.longitude,
      );

      if (!nearest || distance < nearest.distance) {
        nearest = { deviceId: otherPos.deviceId, distance };
      }

      this.evaluatePair(deviceId, otherPos.deviceId, distance);
    });

    if (nearest !== null) {
      const { deviceId: nearestDeviceId, distance } = nearest as { deviceId: string; distance: number };
      if (distance <= this.VISIBILITY_METERS) {
        this.io.emit('proximity:distance_update', {
          deviceId,
          nearestDeviceId,
          distance: Math.round(distance),
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  isInsideAnyRoute(position: EvaluatedPosition, activeGeofences: Geofence[]): boolean {
    return activeGeofences.some(
      (g) =>
        g.shapeType === 'polyline' &&
        isInsideGeofence(position.latitude, position.longitude, g),
    );
  }

  evaluatePair(deviceId1: string, deviceId2: string, distance: number): void {
    const pairKey = [deviceId1, deviceId2].sort().join('-');
    const currentAlert = this.proximityAlerts[pairKey] || 'none';

    if (distance <= this.CRITICAL_METERS) {
      if (currentAlert !== 'critical') {
        this.triggerCritical(deviceId1, deviceId2, distance);
        this.proximityAlerts[pairKey] = 'critical';
      }
    } else if (distance <= this.WARNING_METERS) {
      if (currentAlert === 'none') {
        this.triggerWarning(deviceId1, deviceId2, distance);
        this.proximityAlerts[pairKey] = 'warning';
      }
    } else if (currentAlert !== 'none') {
      this.clearAlert(deviceId1, deviceId2);
      this.proximityAlerts[pairKey] = 'none';
    }
  }

  triggerWarning(deviceId1: string, deviceId2: string, distance: number): void {
    console.log(
      ` PROXIMIDAD FUERA DE RUTA - Vehículos ${deviceId1} y ${deviceId2} a ${Math.round(distance)}m`,
    );

    const payload = {
      type: 'proximity_warning',
      deviceId1,
      deviceId2,
      distance: Math.round(distance),
      message: `PRECAUCIÓN - VEHÍCULOS ${deviceId1} Y ${deviceId2} A ${Math.round(distance)} METROS - FUERA DE RUTA`,
      timestamp: new Date().toISOString(),
    };

    this.io.emit('proximity:warning', payload);
    this.io.emit('supervisor:proximity', { ...payload, level: 1 });

    this._recordAlertEvent(deviceId1, deviceId2, 'warning', payload.message, {
      distance: payload.distance,
    });
  }

  triggerCritical(deviceId1: string, deviceId2: string, distance: number): void {
    console.log(
      `PROXIMIDAD CRÍTICA FUERA DE RUTA - Vehículos ${deviceId1} y ${deviceId2} a ${Math.round(distance)}m`,
    );

    const payload = {
      type: 'proximity_critical',
      deviceId1,
      deviceId2,
      distance: Math.round(distance),
      message: `PELIGRO - VEHÍCULOS ${deviceId1} Y ${deviceId2} MUY CERCA FUERA DE RUTA - REDUZCA VELOCIDAD`,
      loop: true,
      timestamp: new Date().toISOString(),
    };

    this.io.emit('proximity:critical', payload);
    this.io.emit('supervisor:proximity', { ...payload, level: 2 });

    this._recordAlertEvent(deviceId1, deviceId2, 'danger', payload.message, {
      distance: payload.distance,
    });
  }

  clearAlert(deviceId1: string, deviceId2: string): void {
    console.log(`Vehículos ${deviceId1} y ${deviceId2} ya no están en riesgo de proximidad`);

    const timestamp = new Date().toISOString();
    this.io.emit('proximity:clear', { deviceId1, deviceId2, timestamp });
    this.io.emit('supervisor:proximity', { deviceId1, deviceId2, level: 0, timestamp });

    this._resolveAlertEvent(deviceId1, deviceId2);
  }

  _recordAlertEvent(
    deviceId1: string,
    deviceId2: string,
    severity: 'warning' | 'danger',
    message: string,
    metadata: Record<string, unknown>,
  ): void {
    if (!this.alertEventRepo) return;
    const [a, b] = [deviceId1, deviceId2].sort();
    this.alertEventRepo
      .recordOrEscalate({ alertType: 'proximity', severity, deviceId: a, deviceId2: b, message, metadata })
      .catch((err: Error) => console.error('VehicleProximityService._recordAlertEvent:', err.message));
  }

  _resolveAlertEvent(deviceId1: string, deviceId2: string): void {
    if (!this.alertEventRepo) return;
    const [a, b] = [deviceId1, deviceId2].sort();
    this.alertEventRepo
      .resolveOpen({ alertType: 'proximity', deviceId: a, deviceId2: b })
      .catch((err: Error) => console.error('VehicleProximityService._resolveAlertEvent:', err.message));
  }

  calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  toRad(deg: number): number {
    return deg * (Math.PI / 180);
  }

  clearDevice(deviceId: string, otherDeviceIds: string[]): void {
    otherDeviceIds.forEach((otherId) => {
      const pairKey = [deviceId, otherId].sort().join('-');
      const currentAlert = this.proximityAlerts[pairKey];
      if (currentAlert && currentAlert !== 'none') {
        this.clearAlert(deviceId, otherId);
      }
      delete this.proximityAlerts[pairKey];
    });
  }
}

export default VehicleProximityService;
