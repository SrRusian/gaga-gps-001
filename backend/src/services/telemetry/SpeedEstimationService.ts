import { haversineDistance } from '../../utils/geometry';

export interface SpeedEstimationOptions {
  emaAlpha?: number;
  maxDivergenceKmh?: number;
  minSpeedKmh?: number;
  maxAccuracyForDerivedMeters?: number;
  maxGapSecondsForDerived?: number;
  absoluteCeilingKmh?: number;
}

interface DeviceSpeedState {
  lastFix: { lat: number; lon: number; fixTimeMs: number; accuracyMeters: number } | null;
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
  maxAccuracyForDerivedMeters: number;
  maxGapSecondsForDerived: number;
  absoluteCeilingKmh: number;
  deviceState: Record<string, DeviceSpeedState>;

  constructor({
    emaAlpha = 0.35,
    maxDivergenceKmh = 15,
    minSpeedKmh = 1,
    maxAccuracyForDerivedMeters = 30,
    maxGapSecondsForDerived = 10,
    absoluteCeilingKmh = 200,
  }: SpeedEstimationOptions = {}) {
    this.emaAlpha = emaAlpha;
    this.maxDivergenceKmh = maxDivergenceKmh;
    this.minSpeedKmh = minSpeedKmh;
    this.maxAccuracyForDerivedMeters = maxAccuracyForDerivedMeters;
    this.maxGapSecondsForDerived = maxGapSecondsForDerived;
    this.absoluteCeilingKmh = absoluteCeilingKmh;
    this.deviceState = {};
  }

  estimate(
    deviceId: string,
    lat: number,
    lon: number,
    fixTimeMs: number,
    reportedSpeedMs?: number,
    accuracyMeters?: number,
  ): SpeedEstimate {
    const rawDeviceKmh = reportedSpeedMs != null ? reportedSpeedMs * 3.6 : null;
    const accuracy = accuracyMeters != null && accuracyMeters > 0 ? accuracyMeters : null;

    if (!this.deviceState[deviceId]) {
      this.deviceState[deviceId] = { lastFix: null, smoothedKmh: null };
    }
    const state = this.deviceState[deviceId];

    const derivedKmh = this._deriveFromDisplacement(state, lat, lon, fixTimeMs, accuracy);
    state.lastFix = { lat, lon, fixTimeMs, accuracyMeters: accuracy ?? 0 };

    const blendedKmh = this._blend(rawDeviceKmh, derivedKmh, state.smoothedKmh);

    const prevSmoothed = state.smoothedKmh ?? blendedKmh;
    const smoothedKmh = this.emaAlpha * blendedKmh + (1 - this.emaAlpha) * prevSmoothed;
    state.smoothedKmh = smoothedKmh;

    // clamp solo en el retorno, no en el estado - si no, el arranque real tarda mas
    const reportedKmh = smoothedKmh < this.minSpeedKmh ? 0 : smoothedKmh;

    return { speedMs: reportedKmh / 3.6, rawDeviceKmh, derivedKmh };
  }

  // null cuando la geometria no puede medir velocidad de forma confiable: sin fix previo, hueco
  // demasiado largo, precision peor que el umbral, o desplazamiento por debajo de la propia
  // incertidumbre de las dos posiciones (ahi la "distancia" es ruido, no movimiento)
  _deriveFromDisplacement(
    state: DeviceSpeedState,
    lat: number,
    lon: number,
    fixTimeMs: number,
    accuracy: number | null,
  ): number | null {
    const previous = state.lastFix;
    if (!previous) return null;

    const dtSeconds = (fixTimeMs - previous.fixTimeMs) / 1000;
    if (dtSeconds <= 0 || dtSeconds > this.maxGapSecondsForDerived) return null;

    if (accuracy != null && accuracy > this.maxAccuracyForDerivedMeters) return null;
    if (previous.accuracyMeters > this.maxAccuracyForDerivedMeters) return null;

    const distanceMeters = haversineDistance(previous.lat, previous.lon, lat, lon);
    const uncertaintyMeters = (accuracy ?? 0) + previous.accuracyMeters;
    if (distanceMeters <= uncertaintyMeters) return null;

    return (distanceMeters / dtSeconds) * 3.6;
  }

  // si divergen demasiado, descarta el crudo (Doppler) y usa solo la derivada - la derivada ya
  // solo existe cuando es geometricamente confiable (ver _deriveFromDisplacement), que es lo que
  // faltaba antes: con posiciones de antena celular saltando 800m de golpe se derivaban 1039 km/h
  // y ganaban, produciendo 393 km/h reales en produccion con alertas e infracciones falsas.
  // Sin ninguna medicion confiable no se inventa un valor: se sostiene el ultimo suavizado.
  _blend(rawDeviceKmh: number | null, derivedKmh: number | null, smoothedKmh: number | null): number {
    let blended: number;
    if (rawDeviceKmh != null && derivedKmh != null) {
      blended =
        Math.abs(rawDeviceKmh - derivedKmh) > this.maxDivergenceKmh
          ? derivedKmh
          : (rawDeviceKmh + derivedKmh) / 2;
    } else {
      blended = rawDeviceKmh ?? derivedKmh ?? smoothedKmh ?? 0;
    }
    return Math.min(Math.max(blended, 0), this.absoluteCeilingKmh);
  }

  // corta la continuidad de la traza sin borrar la velocidad ya suavizada - se llama cuando el
  // filtro anti-teletransporte resincroniza tras varios saltos: la distancia que cruza esa
  // discontinuidad no es movimiento real del vehiculo y no debe producir velocidad derivada
  resetTrack(deviceId: string): void {
    const state = this.deviceState[deviceId];
    if (state) state.lastFix = null;
  }
}

export default SpeedEstimationService;
