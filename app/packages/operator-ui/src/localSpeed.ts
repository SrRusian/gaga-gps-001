import type { Geofence } from '@gaga-gps/shared-types';

// Evaluacion de exceso de velocidad del lado de la tableta. Desde el rediseño de "la tableta
// evalua, el servidor registra", el Operador decide esto con los limites que ya tiene cacheados,
// sin ida y vuelta al servidor - asi el aviso es inmediato y sigue funcionando sin conexion.
//
// Duplica el criterio de backend/src/services/alerts/SpeedAlertService.ts (gana el limite mas
// estricto; aviso al 90%, infraccion al pasarlo) - shared-types no puede exportar valores reales,
// mismo criterio ya aplicado a offlineGeofences.ts. Si cambia alla, replicar aqui.

// el aviso temprano NO se reporta al servidor a proposito: es para que el operador corrija a
// tiempo, no para dejarle un registro encima (pedido explicito de una ronda anterior)
const WARNING_RATIO = 0.9;

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

export function evaluateSpeed(
  speedKmh: number,
  limits: SpeedLimits,
  geofence: Geofence | null,
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
  return { severity: null, limitKmh, speedKmh, message: '' };
}
