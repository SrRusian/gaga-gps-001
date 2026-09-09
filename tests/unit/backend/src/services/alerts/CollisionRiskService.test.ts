import { beforeEach, describe, expect, it, vi } from 'vitest';
import CollisionRiskService from '../../../../../../backend/src/services/alerts/CollisionRiskService';

const LAT = 19.35;
const LON = -103.56;
const METERS_PER_DEG_LAT = 111320;

function pos(deviceId: number, lat: number, lon = LON) {
  return { deviceId, latitude: lat, longitude: lon };
}

function north(meters: number) {
  return LAT + meters / METERS_PER_DEG_LAT;
}

describe('CollisionRiskService', () => {
  let io: { emit: ReturnType<typeof vi.fn<(event: string, payload: unknown) => void>> };
  let service: InstanceType<typeof CollisionRiskService>;

  beforeEach(() => {
    io = { emit: vi.fn<(event: string, payload: unknown) => void>() };
    service = new CollisionRiskService({ io });
  });

  function primeStaticDevice(deviceId: number) {
    service.evaluate(pos(deviceId, LAT), {});
    service.evaluate(pos(deviceId, LAT), {});
  }

  it('no evalúa nada con menos de 2 posiciones en el historial del propio dispositivo', () => {
    service.evaluate(pos(1, north(50)), {});
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('no evalúa contra un vehículo con menos de 2 posiciones en su historial', () => {
    service.evaluate(pos(2, LAT), {});
    service.evaluate(pos(1, north(200)), {});
    io.emit.mockClear();
    service.evaluate(pos(1, north(50)), { 2: pos(2, LAT) });
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('detecta proximidad (<=80m, convergiendo) y emite collision:proximity + supervisor:collision nivel 1', () => {
    primeStaticDevice(2);
    service.evaluate(pos(1, north(200)), {});
    io.emit.mockClear();

    service.evaluate(pos(1, north(60)), { 2: pos(2, LAT) });

    expect(io.emit).toHaveBeenCalledWith(
      'collision:proximity',
      expect.objectContaining({ deviceId1: 1, deviceId2: 2, distance: 60 }),
    );
    expect(io.emit).toHaveBeenCalledWith(
      'supervisor:collision',
      expect.objectContaining({ level: 1 }),
    );
  });

  it('no re-dispara proximity en cada evaluación mientras se mantiene en el mismo nivel', () => {
    primeStaticDevice(2);
    service.evaluate(pos(1, north(200)), {});
    service.evaluate(pos(1, north(60)), { 2: pos(2, LAT) });
    io.emit.mockClear();

    service.evaluate(pos(1, north(55)), { 2: pos(2, LAT) });
    expect(io.emit.mock.calls.some(([event]) => event === 'collision:proximity')).toBe(
      false,
    );
  });

  it('detecta colisión crítica (<=40m, convergiendo) y emite collision:critical + supervisor:collision nivel 2', () => {
    primeStaticDevice(2);
    service.evaluate(pos(1, north(200)), {});
    io.emit.mockClear();

    service.evaluate(pos(1, north(30)), { 2: pos(2, LAT) });

    expect(io.emit).toHaveBeenCalledWith(
      'collision:critical',
      expect.objectContaining({ deviceId1: 1, deviceId2: 2, distance: 30 }),
    );
    expect(io.emit).toHaveBeenCalledWith(
      'supervisor:collision',
      expect.objectContaining({ level: 2 }),
    );
  });

  it('no dispara nada si los vehículos convergen pero están fuera de ambos umbrales', () => {
    primeStaticDevice(2);
    service.evaluate(pos(1, north(500)), {});
    io.emit.mockClear();

    service.evaluate(pos(1, north(150)), { 2: pos(2, LAT) });
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('emite collision:clear + supervisor:collision nivel 0 al separarse tras haber estado en alerta', () => {
    primeStaticDevice(2);
    service.evaluate(pos(1, north(200)), {});
    service.evaluate(pos(1, north(60)), { 2: pos(2, LAT) });
    io.emit.mockClear();

    service.evaluate(pos(1, north(500)), { 2: pos(2, LAT) });

    expect(io.emit).toHaveBeenCalledWith(
      'collision:clear',
      expect.objectContaining({ deviceId1: 1, deviceId2: 2 }),
    );
    expect(io.emit).toHaveBeenCalledWith(
      'supervisor:collision',
      expect.objectContaining({ deviceId1: 1, deviceId2: 2, level: 0 }),
    );
  });

  it('mantiene "critical" cuando la convergencia parpadea por ruido de GPS (fix histéresis) - sin esto, dos vehículos casi estáticos disparan/limpian la alerta sin parar', () => {
    primeStaticDevice(2);
    service.evaluate(pos(1, north(200)), {});
    service.evaluate(pos(1, north(30)), { 2: pos(2, LAT) });
    io.emit.mockClear();

    service.evaluate(pos(1, north(32)), { 2: pos(2, LAT) });

    expect(io.emit).not.toHaveBeenCalledWith('collision:clear', expect.anything());
    expect(service.collisionAlerts['1-2']).toBe('critical');
  });

  it('limpia "critical" solo cuando la distancia crece más allá del umbral con margen de histéresis', () => {
    primeStaticDevice(2);
    service.evaluate(pos(1, north(200)), {});
    service.evaluate(pos(1, north(30)), { 2: pos(2, LAT) });
    io.emit.mockClear();

    service.evaluate(pos(1, north(85)), { 2: pos(2, LAT) });
    expect(io.emit).not.toHaveBeenCalledWith('collision:clear', expect.anything());

    service.evaluate(pos(1, north(100)), { 2: pos(2, LAT) });
    expect(io.emit).toHaveBeenCalledWith(
      'collision:clear',
      expect.objectContaining({ deviceId1: 1, deviceId2: 2 }),
    );
  });

  it('pares distintos con IDs de texto no comparten estado interno (bug corregido: Math.min con strings daba NaN para todos los pares)', () => {
    const sPos = (id: string, lat: number, lon = LON) =>
      ({ deviceId: id, latitude: lat, longitude: lon }) as unknown as ReturnType<typeof pos>;

    service.evaluate(sPos('CAMION-A', LAT), {});
    service.evaluate(sPos('CAMION-A', LAT), {});
    service.evaluate(sPos('CAMION-B', LAT), {});
    service.evaluate(sPos('CAMION-B', LAT), {});
    service.evaluate(sPos('CAMION-A', LAT), { 'CAMION-B': sPos('CAMION-B', LAT) });
    io.emit.mockClear();

    service.evaluate(sPos('CAMION-C', north(5000)), {});
    service.evaluate(sPos('CAMION-C', north(5000)), {});
    service.evaluate(sPos('CAMION-D', north(5100)), {});
    service.evaluate(sPos('CAMION-D', north(5100)), {});
    service.evaluate(sPos('CAMION-C', north(5000)), { 'CAMION-D': sPos('CAMION-D', north(5100)) });

    expect(io.emit).not.toHaveBeenCalledWith('collision:clear', expect.anything());
  });

  it('el par se identifica siempre con la misma llave sin importar el orden self/other, aunque el payload preserve self/other', () => {
    primeStaticDevice(2);
    service.evaluate(pos(5, north(200)), {});
    io.emit.mockClear();

    service.evaluate(pos(5, north(30)), { 2: pos(2, LAT) });
    expect(io.emit).toHaveBeenCalledWith(
      'collision:critical',
      expect.objectContaining({ deviceId1: 5, deviceId2: 2 }),
    );

    io.emit.mockClear();
    service.evaluate(pos(5, north(28)), { 2: pos(2, LAT) });
    expect(io.emit.mock.calls.some(([event]) => event === 'collision:critical')).toBe(
      false,
    );
  });

  it('mantiene solo las últimas 5 posiciones del historial por dispositivo', () => {
    for (let i = 0; i < 8; i++) {
      service.evaluate(pos(1, north(i * 10)), {});
    }
    expect(service.positionHistory[1]).toHaveLength(5);
  });
});
