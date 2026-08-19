import { beforeEach, describe, expect, it } from 'vitest';
import PositionFilterService from './PositionFilterService';

function pos(lat: number, lon: number, fixTime: string | Date) {
  return { deviceId: 'V1', latitude: lat, longitude: lon, fixTime };
}

describe('PositionFilterService', () => {
  let filter: InstanceType<typeof PositionFilterService>;

  beforeEach(() => {
    filter = new PositionFilterService();
  });

  it('acepta el primer fix de un dispositivo sin comparar contra nada', () => {
    const result = filter.evaluate(pos(19.35, -103.56, '2026-01-01T00:00:00Z'));
    expect(result).toEqual({
      accepted: true,
      reason: null,
      impliedSpeedKmh: null,
      allowedMaxKmh: null,
      distanceMeters: null,
      resynced: false,
    });
  });

  it('descarta un fix fuera de orden (dtSeconds <= 0) sin afectar el contador de rechazos', () => {
    filter.evaluate(pos(19.35, -103.56, '2026-01-01T00:00:10Z'));
    const result = filter.evaluate(pos(19.35, -103.56, '2026-01-01T00:00:05Z'));
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('out_of_order');
  });

  it('acepta directo el ruido GPS por debajo del radio de jitter (5m default)', () => {
    filter.evaluate(pos(19.35, -103.56, '2026-01-01T00:00:00Z'));
    const result = filter.evaluate(pos(19.350009, -103.56, '2026-01-01T00:00:01Z'));
    expect(result.accepted).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('acepta un salto de velocidad plausible dentro del umbral adaptativo', () => {
    filter.evaluate(pos(19.35, -103.56, '2026-01-01T00:00:00Z'));
    const result = filter.evaluate(pos(19.353, -103.56, '2026-01-01T00:01:00Z'));
    expect(result.accepted).toBe(true);
    expect(result.impliedSpeedKmh).toBeGreaterThan(0);
    expect(result.impliedSpeedKmh).toBeLessThan(25);
  });

  it('rechaza un salto de velocidad implausible (teletransporte) por debajo del umbral de reintentos', () => {
    filter.evaluate(pos(19.35, -103.56, '2026-01-01T00:00:00Z'));
    const result = filter.evaluate(pos(19.45, -103.56, '2026-01-01T00:00:01Z'));
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('speed_jump');
    expect(result.impliedSpeedKmh).toBeGreaterThan(1000);
  });

  it('resincroniza (fail-open) tras maxConsecutiveRejects saltos seguidos (default 3)', () => {
    filter.evaluate(pos(19.35, -103.56, '2026-01-01T00:00:00Z'));
    filter.evaluate(pos(19.45, -103.56, '2026-01-01T00:00:01Z'));
    filter.evaluate(pos(19.45, -103.56, '2026-01-01T00:00:02Z'));
    const result = filter.evaluate(pos(19.45, -103.56, '2026-01-01T00:00:03Z'));
    expect(result.accepted).toBe(true);
    expect(result.resynced).toBe(true);
    expect(result.reason).toBe('resync_after_rejects');
  });

  it('el umbral adaptativo respeta el piso mínimo configurado (minFloorKmh)', () => {
    const strictFilter = new PositionFilterService({ minFloorKmh: 10, absoluteCeilingKmh: 200 });
    strictFilter.evaluate(pos(19.35, -103.56, '2026-01-01T00:00:00Z'));
    const result = strictFilter.evaluate(pos(19.3505, -103.56, '2026-01-01T00:00:01Z'));
    expect(result.accepted).toBe(false);
    expect(result.allowedMaxKmh).toBe(10);
  });

  it('el umbral adaptativo respeta el techo de seguridad configurado (absoluteCeilingKmh)', () => {
    const filter2 = new PositionFilterService({ absoluteCeilingKmh: 50 });
    filter2.evaluate(pos(19.35, -103.56, '2026-01-01T00:00:00Z'));
    filter2.evaluate(pos(19.36, -103.56, '2026-01-01T00:00:10Z'));
    const status = filter2.evaluate(pos(19.3501, -103.56, '2026-01-01T00:00:20Z'));
    expect(status.allowedMaxKmh).toBeLessThanOrEqual(50);
  });

  it('mantiene estado independiente por dispositivo', () => {
    filter.evaluate({
      deviceId: 'A',
      latitude: 19.35,
      longitude: -103.56,
      fixTime: '2026-01-01T00:00:00Z',
    });
    const resultB = filter.evaluate({
      deviceId: 'B',
      latitude: 0,
      longitude: 0,
      fixTime: '2026-01-01T00:00:00Z',
    });
    expect(resultB.accepted).toBe(true);
    expect(resultB.reason).toBeNull();
  });
});
