import type { Geofence } from '@gaga-gps/shared-types';

// Evaluacion de exceso de velocidad del lado de la tableta. Desde el rediseño de "la tableta
// evalua, el servidor registra", el Operador decide esto con los limites que ya tiene cacheados,
// sin ida y vuelta al servidor - asi el aviso es inmediato y sigue funcionando sin conexion.
//
// Duplica el criterio de backend/src/services/alerts/SpeedAlertService.ts (gana el limite mas
// estricto; aviso al 90%, infraccion al pasarlo) - shared-types no puede exportar valores reales,
// mismo criterio ya aplicado a offlineGeofences.ts. Si cambia alla, replicar aqui.

// el aviso temprano NO se reporta al servidor a proposito: es para que el operador corrija a
// tiempo, no para dejarle un registro encima (pedido explicito de una ronda anterior).
// 0.75 y no 0.9 (pedido explicito tras probarlo en carretera): de 90 a 100 km/h pasan unos pocos
// segundos, asi que avisar al 90% del limite llegaba practicamente junto con el exceso y no daba
// margen para corregir. Al 75% (75 km/h con limite de 100) el operador alcanza a reaccionar.
const WARNING_RATIO = 0.75;

export interface SpeedLimits {
  deviceLimitKmh: number | null;
  groupLimitKmh: number | null;
  vehicleTypeLimitKmh: number | null;
}

export const NO_SPEED_LIMITS: SpeedLimits = {
  deviceLimitKmh: null,
  groupLimitKmh: null,
  vehicleTypeLimitKmh: null,
};

export interface SpeedVerdict {
  severity: 'warning' | 'danger' | null;
  limitKmh: number | null;
  speedKmh: number;
  message: string;
}

// gana el mas estricto de los cuatro, ignorando los que no esten definidos. La geocerca entra aqui
// porque una zona puede imponer un limite mas bajo que el del propio vehiculo
export function resolveSpeedLimit(limits: SpeedLimits, geofence: Geofence | null): number | null {
  const candidates = [
    limits.deviceLimitKmh,
    limits.groupLimitKmh,
    limits.vehicleTypeLimitKmh,
    geofence?.speedLimitKmh ?? null,
  ].filter((value): value is number => typeof value === 'number' && value > 0);

  return candidates.length > 0 ? Math.min(...candidates) : null;
}

// Segundos de reaccion que se le quieren dar al operador ANTES de pasarse. El 75% fijo no alcanza
// en un vehiculo que acelera fuerte: con 100 km/h de limite, de 75 a 100 son ~2s a fondo. Con la
// aceleracion real medida se avisa cuando faltan estos segundos para cruzar el limite al ritmo
// actual, sin importar en que porcentaje vaya - el 75% se queda como piso para aceleracion suave.
const REACTION_SECONDS = 4;
// debajo de esto la "aceleracion" es ruido del Doppler, no un aceleron real
const MIN_MEANINGFUL_ACCEL_KMH_PER_S = 1.5;

export function evaluateSpeed(
  speedKmh: number,
  limits: SpeedLimits,
  geofence: Geofence | null,
  accelKmhPerS?: number | null,
): SpeedVerdict {
  const limitKmh = resolveSpeedLimit(limits, geofence);
  if (limitKmh === null) {
    return { severity: null, limitKmh: null, speedKmh, message: '' };
  }

  const rounded = Math.round(speedKmh);
  if (speedKmh > limitKmh) {
    return {
      severity: 'danger',
      limitKmh,
      speedKmh,
      message: `EXCESO DE VELOCIDAD - ${rounded} km/h (límite ${limitKmh} km/h)`,
    };
  }
  if (speedKmh >= limitKmh * WARNING_RATIO) {
    return {
      severity: 'warning',
      limitKmh,
      speedKmh,
      message: `CERCA DEL LÍMITE - ${rounded} km/h (límite ${limitKmh} km/h)`,
    };
  }

  // aviso anticipado por aceleracion: si al ritmo actual cruza el limite dentro de la ventana de
  // reaccion, avisa aunque todavia vaya lejos del 75%
  if (typeof accelKmhPerS === 'number' && accelKmhPerS >= MIN_MEANINGFUL_ACCEL_KMH_PER_S) {
    const secondsToLimit = (limitKmh - speedKmh) / accelKmhPerS;
    if (secondsToLimit <= REACTION_SECONDS) {
      return {
        severity: 'warning',
        limitKmh,
        speedKmh,
        message: `BAJA LA VELOCIDAD - vas a pasar ${limitKmh} km/h en ${Math.max(1, Math.round(secondsToLimit))}s`,
      };
    }
  }
  return { severity: null, limitKmh, speedKmh, message: '' };
}

// Categoria del tipo de vehiculo - decide comportamientos reales, no es una etiqueta.
// 'transport' = vehiculo de carretera, tiene un estado "estacionado" real a ~0 km/h.
// 'machinery'  = maquinaria pesada, trabaja a velocidad de gateo.
export type VehicleCategory = 'transport' | 'machinery';

export const DEFAULT_STATIONARY_SPEED_KMH = 4;

// Umbral de "vehiculo detenido", decidido por la CATEGORIA y no por la velocidad maxima.
//
// Para que un umbral de velocidad sirva tiene que quedar arriba del ruido de medicion (~2.5 km/h
// medido en campo con el receptor bajo techo) Y abajo de la velocidad de trabajo del vehiculo. En
// maquinaria esas dos condiciones no caben juntas: una excavadora trabaja a 2-3 km/h, dentro del
// ruido. No se puede distinguir "parada" de "avanzando despacio", y congelarla esconderia trabajo
// real - que es peor que ver el punto temblar. Por eso en maquinaria se DESACTIVA (0), no se baja.
//
// Antes esto se inferia de max_speed_kmh < 25, que era adivinar la intencion a partir de un numero
// que existe para otra cosa: un cargador que alcanza 30 km/h en traslado quedaba mal clasificado, y
// una maquina sin velocidad maxima capturada caia al default de transporte y se congelaba.
export function stationaryThresholdKmh(category: VehicleCategory | null | undefined): number {
  return category === 'machinery' ? 0 : DEFAULT_STATIONARY_SPEED_KMH;
}

// El aviso anticipado por aceleracion solo tiene sentido donde existe el modo de falla que resuelve
// (acelerar fuerte y pasarse antes de alcanzar a reaccionar). Una maquina no acelera asi, y ahi solo
// seria ruido encima del aviso normal al 75%.
export function usesPredictiveSpeedWarning(category: VehicleCategory | null | undefined): boolean {
  return category !== 'machinery';
}
