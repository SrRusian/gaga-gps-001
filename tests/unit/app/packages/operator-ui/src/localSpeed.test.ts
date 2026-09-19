import { describe, expect, it } from 'vitest';
import type { Geofence } from '@gaga-gps/shared-types';
import {
  evaluateSpeed,
  NO_SPEED_LIMITS,
  resolveSpeedLimit,
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

  it('por debajo del 90% del limite no dice nada', () => {
    expect(evaluateSpeed(80, limits, null).severity).toBeNull();
  });

  it('a partir del 90% avisa, sin marcarlo como exceso', () => {
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
