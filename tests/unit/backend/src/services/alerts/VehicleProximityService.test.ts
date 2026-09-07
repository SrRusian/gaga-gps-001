import { beforeEach, describe, expect, it, vi } from 'vitest';
import VehicleProximityService from '../../../../../../backend/src/services/alerts/VehicleProximityService';

const LAT = 19.35;
const LON = -103.56;
const METERS_PER_DEG_LAT = 111320;

function pos(deviceId: string, lat: number, lon = LON) {
  return { deviceId, latitude: lat, longitude: lon };
}

function north(meters: number) {
  return LAT + meters / METERS_PER_DEG_LAT;
}

const corridor = {
  id: 1,
  projectId: null,
  name: 'Ruta autorizada',
  type: 'warning' as const,
  shapeType: 'polyline' as const,
  corridorWidthMeters: 20,
  geometry: {
    type: 'LineString' as const,
    coordinates: [
      [-103.6, 19.3],
      [-103.5, 19.3],
    ],
  },
};

describe('VehicleProximityService', () => {
  let io: { emit: ReturnType<typeof vi.fn<(event: string, payload: unknown) => void>> };
  let service: InstanceType<typeof VehicleProximityService>;

  beforeEach(() => {
    io = { emit: vi.fn<(event: string, payload: unknown) => void>() };
    service = new VehicleProximityService({ io });
  });

  it('no evalúa nada si no hay otros vehículos en la flota', () => {
    service.evaluate(pos('CAMION-01', LAT), {}, []);
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('emite proximity:distance_update en tiempo real dentro del rango de visibilidad, sin alertar todavía', () => {
    service.evaluate(pos('CAMION-01', north(120)), { 'CAMION-02': pos('CAMION-02', LAT) }, []);

    expect(io.emit).toHaveBeenCalledWith(
      'proximity:distance_update',
      expect.objectContaining({
        deviceId: 'CAMION-01',
        nearestDeviceId: 'CAMION-02',
        distance: 120,
      }),
    );
    expect(io.emit).not.toHaveBeenCalledWith('proximity:warning', expect.anything());
  });

  it('emite proximity:warning + supervisor:proximity nivel 1 por debajo de 80m', () => {
    service.evaluate(pos('CAMION-01', north(60)), { 'CAMION-02': pos('CAMION-02', LAT) }, []);

    expect(io.emit).toHaveBeenCalledWith(
      'proximity:warning',
      expect.objectContaining({ deviceId1: 'CAMION-01', deviceId2: 'CAMION-02', distance: 60 }),
    );
    expect(io.emit).toHaveBeenCalledWith(
      'supervisor:proximity',
      expect.objectContaining({ level: 1 }),
    );
  });

  it('emite proximity:critical + supervisor:proximity nivel 2 por debajo de 35m', () => {
    service.evaluate(pos('CAMION-01', north(30)), { 'CAMION-02': pos('CAMION-02', LAT) }, []);

    expect(io.emit).toHaveBeenCalledWith(
      'proximity:critical',
      expect.objectContaining({ deviceId1: 'CAMION-01', deviceId2: 'CAMION-02', distance: 30 }),
    );
    expect(io.emit).toHaveBeenCalledWith(
      'supervisor:proximity',
      expect.objectContaining({ level: 2 }),
    );
  });

  it('no re-dispara warning en cada evaluación mientras se mantiene en el mismo nivel', () => {
    service.evaluate(pos('CAMION-01', north(60)), { 'CAMION-02': pos('CAMION-02', LAT) }, []);
    io.emit.mockClear();

    service.evaluate(pos('CAMION-01', north(55)), { 'CAMION-02': pos('CAMION-02', LAT) }, []);
    expect(io.emit.mock.calls.some(([event]) => event === 'proximity:warning')).toBe(
      false,
    );
  });

  it('emite proximity:clear + supervisor:proximity nivel 0 al separarse tras haber estado en alerta', () => {
    service.evaluate(pos('CAMION-01', north(60)), { 'CAMION-02': pos('CAMION-02', LAT) }, []);
    io.emit.mockClear();

    service.evaluate(pos('CAMION-01', north(500)), { 'CAMION-02': pos('CAMION-02', LAT) }, []);
    expect(io.emit).toHaveBeenCalledWith(
      'proximity:clear',
      expect.objectContaining({ deviceId1: 'CAMION-01', deviceId2: 'CAMION-02' }),
    );
    expect(io.emit).toHaveBeenCalledWith(
      'supervisor:proximity',
      expect.objectContaining({ deviceId1: 'CAMION-01', deviceId2: 'CAMION-02', level: 0 }),
    );
  });

  it('no evalúa nada si el vehículo propio está dentro de un corredor autorizado', () => {
    service.evaluate(
      pos('CAMION-01', 19.3, -103.55),
      { 'CAMION-02': pos('CAMION-02', 19.3, -103.55) },
      [corridor],
    );
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('ignora al otro vehículo si está dentro de un corredor autorizado, aunque el propio no lo esté', () => {
    const farFromCorridor = 19.3 + 500 / METERS_PER_DEG_LAT;
    service.evaluate(
      pos('CAMION-01', farFromCorridor, -103.55),
      { 'CAMION-02': pos('CAMION-02', 19.3, -103.55) },
      [corridor],
    );
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('la clave de par usa orden alfabético de strings, no Math.min/Math.max numérico (evita el bug conocido de CollisionRiskService)', () => {
    service.evaluate(pos('V9', north(30)), { V10: pos('V10', LAT) }, []);
    expect(io.emit).toHaveBeenCalledWith(
      'proximity:critical',
      expect.objectContaining({ deviceId1: 'V9', deviceId2: 'V10' }),
    );

    io.emit.mockClear();
    service.evaluate(pos('V9', north(28)), { V10: pos('V10', LAT) });
    expect(io.emit.mock.calls.some(([event]) => event === 'proximity:critical')).toBe(
      false,
    );
  });
});
