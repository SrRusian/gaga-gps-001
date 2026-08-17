/**
 * SpeedEstimationService - velocidad suavizada y validada.
 *
 * Combina el `speed` del GPS (Doppler, ruidoso) con la velocidad
 * derivada del desplazamiento real (Haversine/Δt) y aplica un EMA.
 * Si ambas fuentes divergen demasiado, prioriza la derivada.
 *
 * Un vehículo parado NUNCA reporta exactamente 0 km/h de forma
 * natural - la posición GPS "tiembla" unos metros incluso sin
 * movimiento real (deriva típica de un fix urbano/interior, sin RTK),
 * y como `haversineDistance` siempre da una distancia positiva sin
 * importar la dirección del temblor, ese ruido se traduce en un piso
 * artificial de velocidad derivada de unos pocos décimos de km/h -
 * nunca decae a cero aunque se promedie. `minSpeedKmh` es la zona
 * muerta que corrige esto: por debajo del umbral, se reporta 0 en
 * vez de dejar pasar el ruido como si fuera movimiento real.
 */
import { haversineDistance } from '../../utils/geometry';

export interface SpeedEstimationOptions {
  emaAlpha?: number;
  maxDivergenceKmh?: number;
  minSpeedKmh?: number;
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
  minSpeedKmh: number;
  deviceState: Record<string, DeviceSpeedState>;

  constructor({
    emaAlpha = 0.35,
    maxDivergenceKmh = 15,
    minSpeedKmh = 1,
  }: SpeedEstimationOptions = {}) {
    this.emaAlpha = emaAlpha;
    this.maxDivergenceKmh = maxDivergenceKmh;
    this.minSpeedKmh = minSpeedKmh;
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

    // La zona muerta se aplica solo al valor reportado, no al estado
    // interno del EMA - si se guardara el 0 clampeado como
    // `smoothedKmh`, el promedio quedaría distorsionado y arrancar a
    // moverse de verdad tardaría más en reflejarse (el EMA partiría
    // de un piso falso en vez del ruido real ya presente).
    const reportedKmh = smoothedKmh < this.minSpeedKmh ? 0 : smoothedKmh;

    return { speedMs: reportedKmh / 3.6, rawDeviceKmh, derivedKmh };
  }
}

export default SpeedEstimationService;
