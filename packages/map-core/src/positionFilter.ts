/**
 * positionFilter.ts
 *
 * Copia del lado del navegador de `PositionFilterService`
 * (`apps/backend/src/services/telemetry/PositionFilterService.ts`) —
 * misma lógica exacta, aplicada aquí al sensor local del operador
 * (`useDeviceGeolocation`) para que un salto físicamente implausible
 * (glitch fix/float del RTK) tampoco se muestre en su propia pantalla,
 * igual que el backend ya lo descarta para lo que ve el resto de la
 * flota. No comparten un paquete en común porque el backend no puede
 * depender de `map-core` (trae React/MapLibre) — si se ajusta el
 * criterio en un lado, replicarlo en el otro.
 */
import { haversineMeters } from './geometry';

export interface PositionFilterOptions {
  toleranceFactor?: number;
  minFloorKmh?: number;
  absoluteCeilingKmh?: number;
  jitterRadiusMeters?: number;
  historyWindow?: number;
  maxConsecutiveRejects?: number;
}

export interface FilterablePosition {
  deviceId: string;
  latitude: number;
  longitude: number;
  fixTime: Date | string | number;
}

export interface FilterResult {
  accepted: boolean;
  reason: string | null;
  impliedSpeedKmh: number | null;
  allowedMaxKmh: number | null;
  distanceMeters: number | null;
  resynced: boolean;
}

interface DeviceFilterState {
  lastAccepted: { lat: number; lon: number; fixTime: Date } | null;
  recentSpeedsKmh: number[];
  consecutiveRejects: number;
}

export class PositionFilterService {
  toleranceFactor: number;
  minFloorKmh: number;
  absoluteCeilingKmh: number;
  jitterRadiusMeters: number;
  historyWindow: number;
  maxConsecutiveRejects: number;
  deviceState: Record<string, DeviceFilterState>;

  constructor({
    toleranceFactor = 1.8,
    minFloorKmh = 25,
    absoluteCeilingKmh = 120,
    jitterRadiusMeters = 5,
    historyWindow = 8,
    maxConsecutiveRejects = 3,
  }: PositionFilterOptions = {}) {
    this.toleranceFactor = toleranceFactor;
    this.minFloorKmh = minFloorKmh;
    this.absoluteCeilingKmh = absoluteCeilingKmh;
    this.jitterRadiusMeters = jitterRadiusMeters;
    this.historyWindow = historyWindow;
    this.maxConsecutiveRejects = maxConsecutiveRejects;

    this.deviceState = {};
  }

  evaluate(position: FilterablePosition): FilterResult {
    const { deviceId, latitude, longitude } = position;
    const fixTime =
      position.fixTime instanceof Date ? position.fixTime : new Date(position.fixTime);

    const state = this.deviceState[deviceId];

    if (!state || !state.lastAccepted) {
      this._accept(deviceId, { lat: latitude, lon: longitude, fixTime }, null);
      return this._result(true, null, null, null, null, false);
    }

    const dtSeconds = (fixTime.getTime() - state.lastAccepted.fixTime.getTime()) / 1000;

    if (dtSeconds <= 0) {
      return this._result(false, 'out_of_order', null, null, null, false);
    }

    const distanceMeters = haversineMeters(
      state.lastAccepted.lat,
      state.lastAccepted.lon,
      latitude,
      longitude,
    );

    if (distanceMeters < this.jitterRadiusMeters) {
      this._accept(
        deviceId,
        { lat: latitude, lon: longitude, fixTime },
        (distanceMeters / dtSeconds) * 3.6,
      );
      return this._result(true, null, null, null, distanceMeters, false);
    }

    const impliedSpeedKmh = (distanceMeters / dtSeconds) * 3.6;
    const allowedMaxKmh = this._allowedMaxKmh(state.recentSpeedsKmh);

    if (impliedSpeedKmh <= allowedMaxKmh) {
      this._accept(deviceId, { lat: latitude, lon: longitude, fixTime }, impliedSpeedKmh);
      return this._result(true, null, impliedSpeedKmh, allowedMaxKmh, distanceMeters, false);
    }

    state.consecutiveRejects += 1;

    if (state.consecutiveRejects >= this.maxConsecutiveRejects) {
      this._accept(
        deviceId,
        { lat: latitude, lon: longitude, fixTime },
        impliedSpeedKmh,
        /* resync */ true,
      );
      return this._result(
        true,
        'resync_after_rejects',
        impliedSpeedKmh,
        allowedMaxKmh,
        distanceMeters,
        true,
      );
    }

    return this._result(false, 'speed_jump', impliedSpeedKmh, allowedMaxKmh, distanceMeters, false);
  }

  _allowedMaxKmh(recentSpeedsKmh: number[]): number {
    const recentMax = recentSpeedsKmh.length > 0 ? Math.max(...recentSpeedsKmh) : 0;
    const adaptive = recentMax * this.toleranceFactor;
    return Math.min(Math.max(adaptive, this.minFloorKmh), this.absoluteCeilingKmh);
  }

  _accept(
    deviceId: string,
    point: { lat: number; lon: number; fixTime: Date },
    speedKmh: number | null,
    resync = false,
  ): void {
    if (!this.deviceState[deviceId]) {
      this.deviceState[deviceId] = {
        lastAccepted: null,
        recentSpeedsKmh: [],
        consecutiveRejects: 0,
      };
    }
    const state = this.deviceState[deviceId];

    state.lastAccepted = point;
    state.consecutiveRejects = 0;

    if (resync) {
      state.recentSpeedsKmh = speedKmh != null ? [speedKmh] : [];
    } else if (speedKmh != null) {
      state.recentSpeedsKmh.push(speedKmh);
      if (state.recentSpeedsKmh.length > this.historyWindow) {
        state.recentSpeedsKmh.shift();
      }
    }
  }

  _result(
    accepted: boolean,
    reason: string | null,
    impliedSpeedKmh: number | null,
    allowedMaxKmh: number | null,
    distanceMeters: number | null,
    resynced: boolean,
  ): FilterResult {
    return { accepted, reason, impliedSpeedKmh, allowedMaxKmh, distanceMeters, resynced };
  }
}
