import { beforeEach, describe, expect, it } from 'vitest';
import SpeedEstimationService from './SpeedEstimationService';

const LAT = 19.35;
const LON = -103.56;
const METERS_PER_DEG_LAT = 111320;

function north(meters: number) {
  return LAT + meters / METERS_PER_DEG_LAT;
}

describe('SpeedEstimationService', () => {
  let service: InstanceType<typeof SpeedEstimationService>;

  beforeEach(() => {
    service = new SpeedEstimationService();
  });

  it('primer fix: usa el speed reportado tal cual (sin punto previo para derivar)', () => {
    const estimate = service.estimate('V1', LAT, LON, 0, 10);
    expect(estimate.rawDeviceKmh).toBeCloseTo(36, 0);
    expect(estimate.derivedKmh).toBeNull();
    expect(estimate.speedMs).toBeCloseTo(10, 1);
  });

  it('combina speed reportado y velocidad derivada cuando ambos coinciden razonablemente', () => {
    service.estimate('V1', LAT, LON, 0, 10);
    // 100m en 10s = 36 km/h derivado, similar al reportado (~40 km/h)
    const estimate = service.estimate('V1', north(100), LON, 10000, 40 / 3.6);
    expect(estimate.derivedKmh).toBeCloseTo(36, 0);
    expect(estimate.speedMs * 3.6).toBeGreaterThan(30);
    expect(estimate.speedMs * 3.6).toBeLessThan(45);
  });

  it('prioriza la velocidad derivada cuando el GPS reportado diverge demasiado', () => {
    service.estimate('V1', LAT, LON, 0, 0);
    // Reportado dice 80km/h, pero el desplazamiento real implica ~7 km/h
    const estimate = service.estimate('V1', north(10), LON, 5000, 80 / 3.6);
    expect(estimate.speedMs * 3.6).toBeLessThan(20);
  });

  it('suaviza velocidad (EMA) — un pico aislado no salta de golpe al valor nuevo', () => {
    service.estimate('V1', LAT, LON, 0, 0);
    service.estimate('V1', north(1), LON, 1000, 0);
    const estimate = service.estimate('V1', north(2), LON, 2000, 100 / 3.6);
    expect(estimate.speedMs * 3.6).toBeLessThan(50);
  });

  it('mantiene estado independiente por dispositivo', () => {
    service.estimate('V1', LAT, LON, 0, 20 / 3.6);
    const v2 = service.estimate('V2', LAT, LON, 0, 5 / 3.6);
    expect(v2.speedMs * 3.6).toBeCloseTo(5, 0);
  });
});
