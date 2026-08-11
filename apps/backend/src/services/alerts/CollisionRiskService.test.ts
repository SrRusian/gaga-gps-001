// Test de caracterización — congela el comportamiento actual ANTES
// de convertir a TypeScript.
//
// Nota clave sobre cómo funciona el módulo (para diseñar los casos):
// evaluate(position, fleetState) actualiza el historial SOLO del
// deviceId de `position` (el "self" de esta llamada) — el historial
// de cualquier "otherPos" en fleetState debe haberse construido en
// llamadas anteriores donde ESE deviceId fue el "self". Por eso cada
// caso arma primero el historial del otro vehículo con 2 llamadas
// (mismo punto, para que quede "estático") antes de mover al vehículo
// bajo prueba.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CollisionRiskService from './CollisionRiskService';

const LAT = 19.35;
const LON = -103.56;
const METERS_PER_DEG_LAT = 111320;

function pos(deviceId: number, lat: number, lon = LON) {
  return { deviceId, latitude: lat, longitude: lon };
}

// Punto a `meters` de distancia al norte del punto fijo (LAT, LON) —
// mismo longitud para que la distancia sea puramente a lo largo de
// un meridiano (independiente del factor cos(lat) de la longitud).
function north(meters: number) {
  return LAT + meters / METERS_PER_DEG_LAT;
}

describe('CollisionRiskService', () => {
  let io: { emit: ReturnType<typeof vi.fn> };
  let service: InstanceType<typeof CollisionRiskService>;

  beforeEach(() => {
    io = { emit: vi.fn() };
    service = new CollisionRiskService({ io });
  });

  /** Construye un historial de 2 entradas para deviceId, estático en (LAT, LON). */
  function primeStaticDevice(deviceId: number) {
    service.evaluate(pos(deviceId, LAT), {});
    service.evaluate(pos(deviceId, LAT), {});
  }

  it('no evalúa nada con menos de 2 posiciones en el historial del propio dispositivo', () => {
    service.evaluate(pos(1, north(50)), {});
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('no evalúa contra un vehículo con menos de 2 posiciones en su historial', () => {
    service.evaluate(pos(2, LAT), {}); // solo 1 entrada para el device 2
    service.evaluate(pos(1, north(200)), {});
    io.emit.mockClear();
    service.evaluate(pos(1, north(50)), { 2: pos(2, LAT) });
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('detecta proximidad (<=80m, convergiendo) y emite collision:proximity + supervisor:collision nivel 1', () => {
    primeStaticDevice(2);
    service.evaluate(pos(1, north(200)), {}); // lejos — primera entrada del historial de 1
    io.emit.mockClear();

    service.evaluate(pos(1, north(60)), { 2: pos(2, LAT) }); // se acerca a 60m

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
    service.evaluate(pos(1, north(60)), { 2: pos(2, LAT) }); // dispara proximity
    io.emit.mockClear();

    service.evaluate(pos(1, north(55)), { 2: pos(2, LAT) }); // sigue en rango proximity
    expect(io.emit.mock.calls.some(([event]: [string]) => event === 'collision:proximity')).toBe(
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

    service.evaluate(pos(1, north(150)), { 2: pos(2, LAT) }); // se acerca, pero sigue >80m
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('emite collision:clear + supervisor:collision nivel 0 al separarse tras haber estado en alerta', () => {
    primeStaticDevice(2);
    service.evaluate(pos(1, north(200)), {});
    service.evaluate(pos(1, north(60)), { 2: pos(2, LAT) }); // dispara proximity
    io.emit.mockClear();

    service.evaluate(pos(1, north(500)), { 2: pos(2, LAT) }); // se aleja — diverge

    expect(io.emit).toHaveBeenCalledWith(
      'collision:clear',
      expect.objectContaining({ deviceId1: 1, deviceId2: 2 }),
    );
    expect(io.emit).toHaveBeenCalledWith(
      'supervisor:collision',
      expect.objectContaining({ deviceId1: 1, deviceId2: 2, level: 0 }),
    );
  });

  it('mantiene "critical" cuando la convergencia parpadea por ruido de GPS (fix histéresis) — sin esto, dos vehículos casi estáticos disparan/limpian la alerta sin parar', () => {
    primeStaticDevice(2);
    service.evaluate(pos(1, north(200)), {});
    service.evaluate(pos(1, north(30)), { 2: pos(2, LAT) }); // dispara critical
    io.emit.mockClear();

    // "Diverge" 2m por ruido de GPS, sigue muy dentro del umbral crítico (40m)
    service.evaluate(pos(1, north(32)), { 2: pos(2, LAT) });

    expect(io.emit).not.toHaveBeenCalledWith('collision:clear', expect.anything());
    expect(service.collisionAlerts['1-2']).toBe('critical');
  });

  it('limpia "critical" solo cuando la distancia crece más allá del umbral con margen de histéresis', () => {
    primeStaticDevice(2);
    service.evaluate(pos(1, north(200)), {});
    service.evaluate(pos(1, north(30)), { 2: pos(2, LAT) }); // critical
    io.emit.mockClear();

    service.evaluate(pos(1, north(85)), { 2: pos(2, LAT) }); // >40m pero dentro del margen — no limpia
    expect(io.emit).not.toHaveBeenCalledWith('collision:clear', expect.anything());

    service.evaluate(pos(1, north(100)), { 2: pos(2, LAT) }); // más allá del margen (80*1.15=92) — limpia
    expect(io.emit).toHaveBeenCalledWith(
      'collision:clear',
      expect.objectContaining({ deviceId1: 1, deviceId2: 2 }),
    );
  });

  it('pares distintos con IDs de texto no comparten estado interno (bug corregido: Math.min con strings daba NaN para todos los pares)', () => {
    // deviceId real es un unique_id de texto — se castea igual que
    // PositionProcessor lo hace en producción.
    const sPos = (id: string, lat: number, lon = LON) =>
      ({ deviceId: id, latitude: lat, longitude: lon }) as unknown as ReturnType<typeof pos>;

    service.evaluate(sPos('CAMION-A', LAT), {});
    service.evaluate(sPos('CAMION-A', LAT), {});
    service.evaluate(sPos('CAMION-B', LAT), {});
    service.evaluate(sPos('CAMION-B', LAT), {});
    service.evaluate(sPos('CAMION-A', LAT), { 'CAMION-B': sPos('CAMION-B', LAT) }); // A-B crítico
    io.emit.mockClear();

    // Par lejano, sin relación — no debe tocar el estado de A-B
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

    // El estado dedup interno usa la clave ordenada "2-5" — una segunda
    // evaluación en el mismo nivel no debe re-disparar.
    io.emit.mockClear();
    service.evaluate(pos(5, north(28)), { 2: pos(2, LAT) });
    expect(io.emit.mock.calls.some(([event]: [string]) => event === 'collision:critical')).toBe(
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
