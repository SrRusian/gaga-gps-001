/**
 * PositionFilterService.ts
 *
 * Responsabilidad: Descartar posiciones físicamente imposibles
 * ("teletransportes") causadas por pérdida momentánea de la
 * corrección RTK/NTRIP — el receptor pierde la corrección ~1s,
 * reporta un punto a decenas de metros de la ruta real, y el
 * siguiente fix vuelve a la posición correcta.
 *
 * No hay dato de calidad de fix (RTK Fixed/Float, HDOP) disponible
 * en el protocolo OsmAnd que usan las tabletas — el filtro es
 * puramente cinemático: compara cada posición nueva contra la
 * última posición ACEPTADA del mismo dispositivo (distancia
 * Haversine / tiempo transcurrido = velocidad implícita).
 *
 * El umbral es adaptativo por dispositivo (no un límite fijo de
 * "tipo de vehículo"): se basa en la velocidad reciente del propio
 * dispositivo, con piso y techo de seguridad. Así, maquinaria
 * pesada lenta rechaza saltos con mucho margen, y un vehículo
 * ligero que ya circula rápido conserva margen para acelerar sin
 * disparar falsos rechazos.
 *
 * Estado en memoria por dispositivo — mismo patrón que
 * CollisionRiskService/SignalLostService (sin Redis).
 */
import { haversineDistance } from '../../utils/geometry';

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

class PositionFilterService {
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

  /**
   * Evalúa una posición entrante contra el historial del dispositivo.
   * No lanza excepciones — en caso de duda, deja pasar (fail-open),
   * ya que congelar a un vehículo fuera del mapa es peor que un
   * salto ocasional visible.
   */
  evaluate(position: FilterablePosition): FilterResult {
    const { deviceId, latitude, longitude } = position;
    const fixTime =
      position.fixTime instanceof Date ? position.fixTime : new Date(position.fixTime);

    const state = this.deviceState[deviceId];

    // Primer fix de este dispositivo (nuevo, o backend recién reiniciado)
    // — nada contra qué comparar, se acepta y se inicializa el estado.
    if (!state || !state.lastAccepted) {
      this._accept(deviceId, { lat: latitude, lon: longitude, fixTime }, null);
      return this._result(true, null, null, null, null, false);
    }

    const dtSeconds = (fixTime.getTime() - state.lastAccepted.fixTime.getTime()) / 1000;

    // Fix duplicado/desordenado — no es un "salto", simplemente se
    // descarta sin afectar el contador de rechazos consecutivos.
    if (dtSeconds <= 0) {
      return this._result(false, 'out_of_order', null, null, null, false);
    }

    const distanceMeters = haversineDistance(
      state.lastAccepted.lat,
      state.lastAccepted.lon,
      latitude,
      longitude,
    );

    // Ruido GPS típico con el vehículo detenido — se acepta directo,
    // evita falsos positivos por dt muy pequeño.
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

    // Salto por encima de lo plausible — candidato a rechazo
    state.consecutiveRejects += 1;

    if (state.consecutiveRejects >= this.maxConsecutiveRejects) {
      // Fail-open: tras varios rechazos seguidos, se asume que el
      // dispositivo de verdad se movió (o volvió tras perder señal)
      // y se resincroniza — evita dejarlo "congelado" en el mapa.
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
      // El historial de velocidades previo ya no es una base
      // confiable tras varios rechazos seguidos — se reinicia.
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

export default PositionFilterService;
