import { describe, expect, it } from 'vitest';
import type { Geofence } from '@gaga-gps/shared-types';
import {
  DEFAULT_STATIONARY_SPEED_KMH,
  evaluateSpeed,
  NO_SPEED_LIMITS,
  resolveSpeedLimit,
  stationaryThresholdKmh,
  usesPredictiveSpeedWarning,
} from '../../../../../../app/packages/operator-ui/src/localSpeed';

function zone(speedLimitKmh: number | null): Geofence {
  return {
    id: 1,
    name: 'Zona',
    type: 'warning',
    projectId: null,
    shapeType: 'circle',
    speedLimitKmh,
    center: { lat: 0, lon: 0 },
    radiusMeters: 100,
  } as Geofence;
}

describe('resolveSpeedLimit', () => {
  it('gana el mas estricto de todos los limites definidos', () => {
    const limit = resolveSpeedLimit(
      { deviceLimitKmh: 80, groupLimitKmh: 60, vehicleTypeLimitKmh: 100 },
      zone(40),
    );
    expect(limit).toBe(40);
  });

  it('ignora los que no estan definidos', () => {
    expect(
      resolveSpeedLimit({ deviceLimitKmh: null, groupLimitKmh: null, vehicleTypeLimitKmh: 100 }, null),
    ).toBe(100);
  });

  it('sin ningun limite configurado no hay limite que aplicar', () => {
    expect(resolveSpeedLimit(NO_SPEED_LIMITS, null)).toBeNull();
    expect(resolveSpeedLimit(NO_SPEED_LIMITS, zone(null))).toBeNull();
  });
});

describe('evaluateSpeed', () => {
  // caso real: T1 tiene 100 km/h por su tipo de vehiculo y alcanzo 92 sin recibir nada
  const limits = { deviceLimitKmh: null, groupLimitKmh: null, vehicleTypeLimitKmh: 100 };

  it('por debajo del 75% del limite no dice nada', () => {
    expect(evaluateSpeed(70, limits, null).severity).toBeNull();
  });

  // 75% y no 90%: de 90 a 100 km/h pasan unos pocos segundos, el aviso llegaba junto con el exceso
  it('a partir del 75% avisa con margen para corregir, sin marcarlo como exceso', () => {
    expect(evaluateSpeed(75, limits, null).severity).toBe('warning');
    const verdict = evaluateSpeed(92, limits, null);
    expect(verdict.severity).toBe('warning');
    expect(verdict.limitKmh).toBe(100);
  });

  it('pasar el limite es exceso real', () => {
    const verdict = evaluateSpeed(104, limits, null);
    expect(verdict.severity).toBe('danger');
    expect(verdict.message).toContain('104');
    expect(verdict.message).toContain('100');
  });

  it('justo en el limite todavia no es exceso', () => {
    expect(evaluateSpeed(100, limits, null).severity).toBe('warning');
  });

  it('el limite de la zona manda si es mas estricto que el del vehiculo', () => {
    const verdict = evaluateSpeed(45, limits, zone(40));
    expect(verdict.severity).toBe('danger');
    expect(verdict.limitKmh).toBe(40);
  });

  it('sin limite configurado nunca alerta, por rapido que vaya', () => {
    expect(evaluateSpeed(180, NO_SPEED_LIMITS, null).severity).toBeNull();
  });
});

describe('stationaryThresholdKmh - decidido por la CATEGORIA del tipo de vehiculo', () => {
  it('transporte congela la posicion al estar detenido', () => {
    expect(stationaryThresholdKmh('transport')).toBe(DEFAULT_STATIONARY_SPEED_KMH);
  });

  // el caso que motivo todo: una excavadora trabaja a 2-3 km/h, dentro del ruido de medicion.
  // Congelarla escondería trabajo real, asi que se desactiva en vez de bajar el umbral.
  it('maquinaria NUNCA congela, sin importar su velocidad maxima', () => {
    expect(stationaryThresholdKmh('machinery')).toBe(0);
  });

  it('sin categoria conocida cae a transporte (comportamiento de siempre)', () => {
    expect(stationaryThresholdKmh(null)).toBe(DEFAULT_STATIONARY_SPEED_KMH);
    expect(stationaryThresholdKmh(undefined)).toBe(DEFAULT_STATIONARY_SPEED_KMH);
  });
});

describe('usesPredictiveSpeedWarning', () => {
  it('solo transporte usa el aviso anticipado por aceleracion', () => {
    expect(usesPredictiveSpeedWarning('transport')).toBe(true);
    expect(usesPredictiveSpeedWarning(null)).toBe(true);
  });

  it('maquinaria no lo usa - no acelera asi, seria ruido sobre el aviso al 75%', () => {
    expect(usesPredictiveSpeedWarning('machinery')).toBe(false);
  });
});
