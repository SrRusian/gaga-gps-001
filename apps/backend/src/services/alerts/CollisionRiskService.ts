interface SocketIoLike {
  emit(event: string, payload: unknown): void;
}

interface AlertEventRepoLike {
  recordOrEscalate(event: {
    alertType: 'collision';
    severity: 'warning' | 'danger';
    deviceId: string;
    deviceId2: string;
    message?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<unknown>;
  resolveOpen(event: { alertType: 'collision'; deviceId: string; deviceId2: string }): Promise<unknown>;
}

interface EvaluatedPosition {
  deviceId: number;
  latitude: number;
  longitude: number;
}

interface HistoryPoint {
  lat: number;
  lon: number;
  timestamp: number;
}

type CollisionAlertLevel = 'none' | 'proximity' | 'critical';

// global, no filtra por proyecto (gap de aislamiento conocido)
class CollisionRiskService {
  io: SocketIoLike;
  alertEventRepo?: AlertEventRepoLike;
  positionHistory: Record<number, HistoryPoint[]>;
  collisionAlerts: Record<string, CollisionAlertLevel>;
  readonly THRESHOLD_1_METERS = 80;
  readonly THRESHOLD_2_METERS = 40;
  readonly CLEAR_MARGIN = 1.15; // histeresis - evita parpadeo por ruido GPS al limpiar

  constructor({ io, alertEventRepo }: { io: SocketIoLike; alertEventRepo?: AlertEventRepoLike }) {
    this.io = io;
    this.alertEventRepo = alertEventRepo;
    this.positionHistory = {};
    this.collisionAlerts = {};
  }

  // fleetState viene keyed por deviceId
  evaluate(position: EvaluatedPosition, fleetState: Record<string, EvaluatedPosition>): void {
    const { deviceId } = position;
    this.updateHistory(position);

    if (!this.positionHistory[deviceId] || this.positionHistory[deviceId].length < 2) {
      return;
    }

    Object.values(fleetState).forEach((otherPos) => {
      if (otherPos.deviceId === deviceId) return;
      if (
        !this.positionHistory[otherPos.deviceId] ||
        this.positionHistory[otherPos.deviceId].length < 2
      )
        return;

      this.evaluatePair(position, otherPos);
    });
  }

  updateHistory(position: EvaluatedPosition): void {
    const { deviceId } = position;

    if (!this.positionHistory[deviceId]) {
      this.positionHistory[deviceId] = [];
    }

    this.positionHistory[deviceId].push({
      lat: position.latitude,
      lon: position.longitude,
      timestamp: Date.now(),
    });

    if (this.positionHistory[deviceId].length > 5) {
      this.positionHistory[deviceId].shift();
    }
  }

  evaluatePair(pos1: EvaluatedPosition, pos2: EvaluatedPosition): void {
    // deviceId es string - sort+join evita el bug viejo de Math.min devolviendo NaN
    const pairKey = [String(pos1.deviceId), String(pos2.deviceId)].sort().join('-');

    const distance = this.calculateDistance(
      pos1.latitude,
      pos1.longitude,
      pos2.latitude,
      pos2.longitude,
    );

    const converging = this.areConverging(pos1.deviceId, pos2.deviceId);
    const currentAlert = this.collisionAlerts[pairKey] || 'none';

    if (distance <= this.THRESHOLD_2_METERS && converging) {
      if (currentAlert !== 'critical') {
        this.triggerCritical(pos1.deviceId, pos2.deviceId, distance);
      }
      this.collisionAlerts[pairKey] = 'critical';
    } else if (distance <= this.THRESHOLD_1_METERS && converging && currentAlert === 'none') {
      this.triggerProximity(pos1.deviceId, pos2.deviceId, distance);
      this.collisionAlerts[pairKey] = 'proximity';
    } else if (currentAlert !== 'none' && distance > this.THRESHOLD_1_METERS * this.CLEAR_MARGIN) {
      this.clearCollisionAlert(pos1.deviceId, pos2.deviceId);
      this.collisionAlerts[pairKey] = 'none';
    }
  }

  areConverging(deviceId1: number, deviceId2: number): boolean {
    const history1 = this.positionHistory[deviceId1];
    const history2 = this.positionHistory[deviceId2];

    if (!history1 || history1.length < 2) return false;
    if (!history2 || history2.length < 2) return false;

    const currentDist = this.calculateDistance(
      history1[history1.length - 1].lat,
      history1[history1.length - 1].lon,
      history2[history2.length - 1].lat,
      history2[history2.length - 1].lon,
    );

    const previousDist = this.calculateDistance(
      history1[history1.length - 2].lat,
      history1[history1.length - 2].lon,
      history2[history2.length - 2].lat,
      history2[history2.length - 2].lon,
    );

    return currentDist < previousDist;
  }

  triggerProximity(deviceId1: number, deviceId2: number, distance: number): void {
    console.log(
      ` PROXIMIDAD - Vehículos ${deviceId1} y ${deviceId2} a ${Math.round(distance)}m convergiendo`,
    );

    const payload = {
      type: 'collision_proximity',
      deviceId1,
      deviceId2,
      distance: Math.round(distance),
      message: `PRECAUCIÓN - VEHÍCULO ${deviceId2} A ${Math.round(distance)} METROS - REDUZCA VELOCIDAD`,
      timestamp: new Date().toISOString(),
    };

    this.io.emit('collision:proximity', payload);
    this.io.emit('supervisor:collision', { ...payload, level: 1 });
    this._recordAlertEvent(deviceId1, deviceId2, 'warning', payload.message, {
      distance: payload.distance,
    });
  }

  triggerCritical(deviceId1: number, deviceId2: number, distance: number): void {
    console.log(
      `COLISIÓN INMINENTE - Vehículos ${deviceId1} y ${deviceId2} a ${Math.round(distance)}m`,
    );

    const payload = {
      type: 'collision_critical',
      deviceId1,
      deviceId2,
      distance: Math.round(distance),
      message: `PELIGRO - COLISIÓN INMINENTE CON VEHÍCULO - DETÉNGASE INMEDIATAMENTE`,
      loop: true,
      timestamp: new Date().toISOString(),
    };

    this.io.emit('collision:critical', payload);
    this.io.emit('supervisor:collision', { ...payload, level: 2 });

    this._recordAlertEvent(deviceId1, deviceId2, 'danger', payload.message, {
      distance: payload.distance,
    });
  }

  clearCollisionAlert(deviceId1: number, deviceId2: number): void {
    console.log(`Vehículos ${deviceId1} y ${deviceId2} ya no están en riesgo de colisión`);

    const timestamp = new Date().toISOString();
    this.io.emit('collision:clear', { deviceId1, deviceId2, timestamp });
    this.io.emit('supervisor:collision', { deviceId1, deviceId2, level: 0, timestamp });

    this._resolveAlertEvent(deviceId1, deviceId2);
  }

  _recordAlertEvent(
    deviceId1: number,
    deviceId2: number,
    severity: 'warning' | 'danger',
    message: string,
    metadata: Record<string, unknown>,
  ): void {
    if (!this.alertEventRepo) return;
    const [a, b] = [String(deviceId1), String(deviceId2)].sort();
    this.alertEventRepo
      .recordOrEscalate({ alertType: 'collision', severity, deviceId: a, deviceId2: b, message, metadata })
      .catch((err: Error) => console.error('CollisionRiskService._recordAlertEvent:', err.message));
  }

  _resolveAlertEvent(deviceId1: number, deviceId2: number): void {
    if (!this.alertEventRepo) return;
    const [a, b] = [String(deviceId1), String(deviceId2)].sort();
    this.alertEventRepo
      .resolveOpen({ alertType: 'collision', deviceId: a, deviceId2: b })
      .catch((err: Error) => console.error('CollisionRiskService._resolveAlertEvent:', err.message));
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
      const currentAlert = this.collisionAlerts[pairKey];
      if (currentAlert && currentAlert !== 'none') {
        this.clearCollisionAlert(deviceId as unknown as number, otherId as unknown as number);
      }
      delete this.collisionAlerts[pairKey];
    });
    delete this.positionHistory[deviceId as unknown as number];
  }
}

export default CollisionRiskService;
