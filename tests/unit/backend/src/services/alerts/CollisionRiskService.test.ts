import { beforeEach, describe, expect, it, vi } from 'vitest';
import CollisionRiskService from '../../../../../../backend/src/services/alerts/CollisionRiskService';
import { buildVehicleFootprintWkt } from '../../../../../../backend/src/utils/vehicleFootprint';

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

type SendToDevice = (deviceId: string, event: string, payload: unknown) => void;
type InfractionCreate = (params: Record<string, unknown>) => Promise<unknown>;
type RouteMembershipLookup = (params: {
  projectId: number | null;
  latitude: number;
  longitude: number;
}) => Promise<{ id: number; name: string; corridorWidthMeters: number; lineFraction: number } | null>;

describe('CollisionRiskService - rutas, dirección y contacto real', () => {
  let io: { emit: ReturnType<typeof vi.fn<(event: string, payload: unknown) => void>> };
  let socketServer: { sendToDevice: ReturnType<typeof vi.fn<SendToDevice>> };
  let infractionRepo: { create: ReturnType<typeof vi.fn<InfractionCreate>> };
  let geofenceRepo: { findRouteMembership: ReturnType<typeof vi.fn<RouteMembershipLookup>> };
  let service: InstanceType<typeof CollisionRiskService>;
  let fleet: Record<string, { deviceId: number; latitude: number; longitude: number; projectId: number; speed: number; footprintWkt?: string | null }>;

  beforeEach(() => {
    io = { emit: vi.fn<(event: string, payload: unknown) => void>() };
    socketServer = { sendToDevice: vi.fn<SendToDevice>() };
    infractionRepo = { create: vi.fn<InfractionCreate>().mockResolvedValue(undefined) };
    geofenceRepo = { findRouteMembership: vi.fn<RouteMembershipLookup>() };
    service = new CollisionRiskService({ io, socketServer, infractionRepo, geofenceRepo });
    fleet = {};
  });

  function routeMatch(fraction: number) {
    return { id: 1, name: 'Ruta A-B', corridorWidthMeters: 20, lineFraction: fraction };
  }

  // 2 ticks a la misma geocerca de ruta con fraccion creciente (o decreciente) - establece
  // direccion 'forward'/'backward' y dos entradas de historial de posicion, requisito para que
  // areConverging/la comparacion de ruta funcionen
  async function primeRouteDevice(deviceId: number, lat: number, fractions: [number, number]) {
    geofenceRepo.findRouteMembership.mockResolvedValueOnce(routeMatch(fractions[0]));
    await service.evaluate({ deviceId, latitude: lat, longitude: LON, projectId: 7, speed: 5 }, fleet);
    fleet[deviceId] = { deviceId, latitude: lat, longitude: LON, projectId: 7, speed: 5 };

    geofenceRepo.findRouteMembership.mockResolvedValueOnce(routeMatch(fractions[1]));
    await service.evaluate({ deviceId, latitude: lat, longitude: LON, projectId: 7, speed: 5 }, fleet);
    fleet[deviceId] = { deviceId, latitude: lat, longitude: LON, projectId: 7, speed: 5 };
  }

  it('mismo sentido, convergiendo a <=40m: dispara collision:critical y crea una infracción', async () => {
    await primeRouteDevice(2, LAT, [0.1, 0.15]); // forward, se queda estatico en LAT/LON
    await primeRouteDevice(1, north(100), [0.4, 0.4]); // primer tick de 1, direccion aun null

    io.emit.mockClear();
    geofenceRepo.findRouteMembership.mockResolvedValueOnce(routeMatch(0.45)); // fraccion sube -> forward
    await service.evaluate({ deviceId: 1, latitude: north(30), longitude: LON, projectId: 7, speed: 10 }, fleet);

    expect(io.emit).toHaveBeenCalledWith(
      'collision:critical',
      expect.objectContaining({ deviceId1: 1, deviceId2: 2 }),
    );
    expect(infractionRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ infractionType: 'collision', deviceId: '1', deviceId2: '2' }),
    );
  });

  it('direccion opuesta: nunca escala a critico/infraccion aunque converjan muy cerca, solo aviso silencioso al operador', async () => {
    await primeRouteDevice(2, LAT, [0.9, 0.85]); // backward
    await primeRouteDevice(1, north(100), [0.4, 0.4]);

    io.emit.mockClear();
    socketServer.sendToDevice.mockClear();
    geofenceRepo.findRouteMembership.mockResolvedValueOnce(routeMatch(0.45)); // forward - opuesto a device 2
    await service.evaluate({ deviceId: 1, latitude: north(30), longitude: LON, projectId: 7, speed: 10 }, fleet);

    expect(io.emit).not.toHaveBeenCalledWith('collision:critical', expect.anything());
    expect(infractionRepo.create).not.toHaveBeenCalled();
    expect(socketServer.sendToDevice).toHaveBeenCalledWith(
      '1',
      'alert:proximity_notice',
      expect.objectContaining({ otherDeviceId: '2' }),
    );
  });

  it('contacto real (siluetas tocandose) es mas grave que "critical" y crea infraccion con kind=contact, sin importar direccion', async () => {
    // rectangulos casi en el mismo punto - se traslapan de verdad
    const footprintA = buildVehicleFootprintWkt(LAT, LON, 0, 8, 2.5);
    const footprintB = buildVehicleFootprintWkt(LAT, LON, 180, 8, 2.5);

    await primeRouteDevice(2, LAT, [0.9, 0.85]); // backward (direccion opuesta a proposito)
    // tick extra de device 2 con su footprint real, para que quede cacheado en footprintByDevice
    // (el objeto `fleet` solo dice "donde esta", no basta para que el servicio conozca su silueta)
    geofenceRepo.findRouteMembership.mockResolvedValueOnce(routeMatch(0.85));
    await service.evaluate(
      { deviceId: 2, latitude: LAT, longitude: LON, projectId: 7, speed: 5, footprintWkt: footprintB },
      fleet,
    );
    fleet[2] = { deviceId: 2, latitude: LAT, longitude: LON, projectId: 7, speed: 5, footprintWkt: footprintB };

    io.emit.mockClear();
    // primer tick de device 1 con su footprint real ya traslapando el de device 2 - el contacto se
    // detecta desde esta misma llamada (no hace falta una segunda)
    geofenceRepo.findRouteMembership.mockResolvedValueOnce(routeMatch(0.4));
    await service.evaluate(
      { deviceId: 1, latitude: LAT, longitude: LON, projectId: 7, speed: 5, footprintWkt: footprintA },
      fleet,
    );

    expect(io.emit).toHaveBeenCalledWith(
      'collision:critical',
      expect.objectContaining({ message: expect.stringContaining('CONTACTO') }),
    );
    expect(infractionRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ kind: 'contact' }) }),
    );
  });

  it('un vehiculo que sale de la ruta deja de contar como "compañero de ruta" de inmediato (sin alerta negativa por salir)', async () => {
    await primeRouteDevice(2, LAT, [0.1, 0.15]);
    await primeRouteDevice(1, north(500), [0.4, 0.4]); // lejos de 2, para que el radar generico tampoco tenga nada que decir

    // device 1 ya no matchea ninguna ruta (ej. salio a un estacionamiento) - el estado de ruta se
    // limpia solo, sin generar ninguna alerta por el simple hecho de salir
    geofenceRepo.findRouteMembership.mockResolvedValueOnce(null);
    io.emit.mockClear();
    await service.evaluate({ deviceId: 1, latitude: north(490), longitude: LON, projectId: 7, speed: 10 }, fleet);

    expect(service.routeStateByDevice['1']).toBeUndefined();
    expect(io.emit).not.toHaveBeenCalled();
  });
});
