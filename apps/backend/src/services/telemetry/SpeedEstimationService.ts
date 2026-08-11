/**
 * SpeedEstimationService — velocidad suavizada y validada.
 *
 * Combina el `speed` del GPS (Doppler, ruidoso) con la velocidad
 * derivada del desplazamiento real (Haversine/Δt) y aplica un EMA.
 * Si ambas fuentes divergen demasiado, prioriza la derivada.
 */
import { haversineDistance } from '../../utils/geometry';

export interface SpeedEstimationOptions {
  emaAlpha?: number;
  maxDivergenceKmh?: number;
}

interface DeviceSpeedState {
  lastFix: { lat: number; lon: number; fixTimeMs: number } | null;
  smoothedKmh: number | null;
}

export interface SpeedEstimate {
  speedMs: number;
  rawDeviceKmh: number | null;
  derivedKmh: number | null;
}

class SpeedEstimationService {
  emaAlpha: number;
  maxDivergenceKmh: number;
  deviceState: Record<string, DeviceSpeedState>;

  constructor({ emaAlpha = 0.35, maxDivergenceKmh = 15 }: SpeedEstimationOptions = {}) {
    this.emaAlpha = emaAlpha;
    this.maxDivergenceKmh = maxDivergenceKmh;
    this.deviceState = {};
  }

  estimate(
    deviceId: string,
    lat: number,
    lon: number,
    fixTimeMs: number,
    reportedSpeedMs?: number,
  ): SpeedEstimate {
    const rawDeviceKmh = reportedSpeedMs != null ? reportedSpeedMs * 3.6 : null;

    if (!this.deviceState[deviceId]) {
      this.deviceState[deviceId] = { lastFix: null, smoothedKmh: null };
    }
    const state = this.deviceState[deviceId];

    let derivedKmh: number | null = null;
    if (state.lastFix) {
      const dtSeconds = (fixTimeMs - state.lastFix.fixTimeMs) / 1000;
      if (dtSeconds > 0) {
        const distanceMeters = haversineDistance(state.lastFix.lat, state.lastFix.lon, lat, lon);
        derivedKmh = (distanceMeters / dtSeconds) * 3.6;
      }
    }
    state.lastFix = { lat, lon, fixTimeMs };

    let blendedKmh: number;
    if (rawDeviceKmh != null && derivedKmh != null) {
      blendedKmh =
        Math.abs(rawDeviceKmh - derivedKmh) > this.maxDivergenceKmh
          ? derivedKmh
          : (rawDeviceKmh + derivedKmh) / 2;
    } else {
      blendedKmh = rawDeviceKmh ?? derivedKmh ?? 0;
    }

    const prevSmoothed = state.smoothedKmh ?? blendedKmh;
    const smoothedKmh = this.emaAlpha * blendedKmh + (1 - this.emaAlpha) * prevSmoothed;
    state.smoothedKmh = smoothedKmh;

    return { speedMs: smoothedKmh / 3.6, rawDeviceKmh, derivedKmh };
  }
}

export default SpeedEstimationService;
