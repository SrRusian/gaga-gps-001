import { beforeEach, describe, expect, it } from 'vitest';
import SpeedEstimationService from '../../../../../../backend/src/services/telemetry/SpeedEstimationService';

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
    const estimate = service.estimate('V1', north(100), LON, 10000, 40 / 3.6);
    expect(estimate.derivedKmh).toBeCloseTo(36, 0);
    expect(estimate.speedMs * 3.6).toBeGreaterThan(30);
    expect(estimate.speedMs * 3.6).toBeLessThan(45);
  });

  it('prioriza la velocidad derivada cuando el GPS reportado diverge demasiado', () => {
    service.estimate('V1', LAT, LON, 0, 0);
    const estimate = service.estimate('V1', north(10), LON, 5000, 80 / 3.6);
    expect(estimate.speedMs * 3.6).toBeLessThan(20);
  });

  it('suaviza velocidad (EMA) - un pico aislado no salta de golpe al valor nuevo', () => {
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

  it('un dispositivo parado con deriva de GPS (unos decímetros de ruido por segundo, no movimiento real) reporta 0, no un piso artificial de ruido', () => {
    service.estimate('V1', LAT, LON, 0, 0);
    service.estimate('V1', north(0.2), LON, 1000, 0);
    service.estimate('V1', north(0.5), LON, 2000, 0);
    const estimate = service.estimate('V1', north(0.65), LON, 3000, 0);
    expect(estimate.speedMs).toBe(0);
  });

  // caso real de produccion (17 sep): posiciones de antena celular con accuracy ~100m saltaban
  // ~800m de golpe y sin Doppler; la velocidad derivada daba 1039 km/h y quedaba guardada como
  // 393 km/h, generando alertas e infracciones falsas contra el operador
  it('no deriva velocidad de posiciones imprecisas: sostiene la ultima conocida en vez de inventar un pico', () => {
    service.estimate('V1', LAT, LON, 0, 40 / 3.6, 2);
    service.estimate('V1', north(11), LON, 1000, 40 / 3.6, 2);
    const before = service.estimate('V1', north(22), LON, 2000, 40 / 3.6, 2);
    // salto de 800m con precision de antena celular y sin velocidad reportada por el dispositivo
    const spike = service.estimate('V1', north(822), LON, 3000, undefined, 100);
    expect(spike.derivedKmh).toBeNull();
    expect(spike.speedMs * 3.6).toBeCloseTo(before.speedMs * 3.6, 1);
  });

  it('no deriva velocidad cuando el desplazamiento cabe dentro de la propia incertidumbre', () => {
    service.estimate('V1', LAT, LON, 0, undefined, 12);
    const estimate = service.estimate('V1', north(15), LON, 1000, undefined, 12);
    expect(estimate.derivedKmh).toBeNull();
  });

  it('nunca reporta por encima del techo de cordura', () => {
    const service2 = new SpeedEstimationService({ emaAlpha: 1, absoluteCeilingKmh: 200 });
    service2.estimate('V1', LAT, LON, 0, 500 / 3.6, 1);
    const estimate = service2.estimate('V1', north(5), LON, 1000, 500 / 3.6, 1);
    expect(estimate.speedMs * 3.6).toBeLessThanOrEqual(200);
  });

  it('resetTrack corta la derivada a traves de una discontinuidad (resync del filtro)', () => {
    service.estimate('V1', LAT, LON, 0, undefined, 2);
    service.resetTrack('V1');
    const estimate = service.estimate('V1', north(900), LON, 1000, undefined, 2);
    expect(estimate.derivedKmh).toBeNull();
  });

  it('respeta un umbral personalizado de zona muerta (minSpeedKmh)', () => {
    const strict = new SpeedEstimationService({ minSpeedKmh: 0 });
    strict.estimate('V1', LAT, LON, 0, 0);
    const estimate = strict.estimate('V1', north(0.14), LON, 1000, 0.5 / 3.6);
    expect(estimate.speedMs).toBeGreaterThan(0);
  });
});
