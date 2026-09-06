import { beforeEach, describe, expect, it, vi } from 'vitest';
import GeofenceAlertService, { type GeofenceMatchRow } from './GeofenceAlertService';

const dangerCircleRow = {
  id: 1,
  name: 'Zona Roja',
  type: 'danger' as const,
  shape_type: 'circle' as const,
  corridor_width_meters: null,
  corridor_danger_margin_meters: null,
  speed_limit_kmh: null,
  distance_meters: 10,
};

const warningCircleRow = {
  id: 2,
  name: 'Zona Amarilla',
  type: 'warning' as const,
  shape_type: 'circle' as const,
  corridor_width_meters: null,
  corridor_danger_margin_meters: null,
  speed_limit_kmh: null,
  distance_meters: 10,
};

const parkingCircleRow = {
  id: 5,
  name: 'Estacionamiento Norte',
  type: 'parking' as const,
  shape_type: 'circle' as const,
  corridor_width_meters: null,
  corridor_danger_margin_meters: null,
  speed_limit_kmh: null,
  distance_meters: 10,
};

const forbiddenPolygonRow = {
  id: 7,
  name: 'Polvorín',
  type: 'forbidden' as const,
  shape_type: 'polygon' as const,
  corridor_width_meters: null,
  corridor_danger_margin_meters: null,
  speed_limit_kmh: null,
  distance_meters: 10,
};

const maintenancePolygonRow = {
  id: 8,
  name: 'Reparación de talud',
  type: 'maintenance' as const,
  shape_type: 'polygon' as const,
  corridor_width_meters: null,
  corridor_danger_margin_meters: null,
  speed_limit_kmh: null,
  distance_meters: 10,
};

const allowedPolygonRow = {
  id: 9,
  name: 'Patio de maniobras',
  type: 'allowed' as const,
  shape_type: 'polygon' as const,
  corridor_width_meters: null,
  corridor_danger_margin_meters: null,
  speed_limit_kmh: null,
  distance_meters: 10,
};

const dischargePolygonRow = {
  id: 10,
  name: 'Tolva',
  type: 'discharge' as const,
  shape_type: 'polygon' as const,
  corridor_width_meters: null,
  corridor_danger_margin_meters: null,
  speed_limit_kmh: null,
  distance_meters: 10,
};

function corridorRow(distanceMeters: number, corridorDangerMarginMeters: number | null = null) {
  return {
    id: 4,
    name: 'Ruta autorizada',
    type: 'warning' as const,
    shape_type: 'polyline' as const,
    corridor_width_meters: 20,
    corridor_danger_margin_meters: corridorDangerMarginMeters,
    speed_limit_kmh: null,
    distance_meters: distanceMeters,
  };
}

function pos(deviceId = 'V1', projectId: number | null = 7) {
  return { deviceId, latitude: 19.35, longitude: -103.56, projectId };
}

type FindMatchingSpatial = (params: {
  projectId: number | null;
  latitude: number;
  longitude: number;
}) => Promise<GeofenceMatchRow[]>;
type BroadcastToProject = (projectId: number | null, event: string, payload: unknown) => void;

describe('GeofenceAlertService', () => {
  let socketServer: { broadcastToProject: ReturnType<typeof vi.fn<BroadcastToProject>> };
  let findMatchingSpatial: ReturnType<typeof vi.fn<FindMatchingSpatial>>;
  let service: InstanceType<typeof GeofenceAlertService>;

  beforeEach(() => {
    socketServer = { broadcastToProject: vi.fn<BroadcastToProject>() };
    findMatchingSpatial = vi.fn<FindMatchingSpatial>().mockResolvedValue([]);
    service = new GeofenceAlertService({
      geofenceRepo: { findMatchingSpatial },
      socketServer,
    });
  });

  it('addGeofence normaliza shapeType a "circle" por default', () => {
    service.addGeofence({
      id: 1,
      name: 'X',
      type: 'warning',
      projectId: 7,
      center: { lat: 0, lon: 0 },
      radiusMeters: 10,
    });
    expect(service.activeGeofences[0].shapeType).toBe('circle');
  });

  it('addGeofence reemplaza una geocerca existente con el mismo id en vez de duplicarla', () => {
    const dangerCircle = {
      id: 1,
      name: 'Zona Roja',
      type: 'danger' as const,
      projectId: 7,
      shapeType: 'circle' as const,
      center: { lat: 19.35, lon: -103.56 },
      radiusMeters: 50,
    };
    service.addGeofence(dangerCircle);
    service.addGeofence({ ...dangerCircle, name: 'Renombrada' });
    expect(service.activeGeofences).toHaveLength(1);
    expect(service.activeGeofences[0].name).toBe('Renombrada');
  });

  it('removeGeofence la quita de las activas', () => {
    service.addGeofence({
      id: 1,
      name: 'Zona Roja',
      type: 'danger',
      projectId: 7,
      shapeType: 'circle',
      center: { lat: 19.35, lon: -103.56 },
      radiusMeters: 50,
    });
    service.removeGeofence(1);
    expect(service.activeGeofences).toHaveLength(0);
  });

  it('consulta findMatchingSpatial con el proyecto y las coordenadas de la posición', async () => {
    await service.evaluate(pos('V1', 7));
    expect(findMatchingSpatial).toHaveBeenCalledWith({
      projectId: 7,
      latitude: 19.35,
      longitude: -103.56,
    });
  });

  it('no emite nada mientras el vehículo está fuera de todas las geocercas', async () => {
    findMatchingSpatial.mockResolvedValue([]);
    await service.evaluate(pos());
    expect(socketServer.broadcastToProject).not.toHaveBeenCalled();
  });

  it('emite alert:critical + supervisor:alert al entrar en una geocerca "danger"', async () => {
    findMatchingSpatial.mockResolvedValue([dangerCircleRow]);
    await service.evaluate(pos());

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      7,
      'alert:critical',
      expect.objectContaining({ type: 'geofence_red', deviceId: 'V1', loop: true }),
    );
    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      7,
      'supervisor:alert',
      expect.objectContaining({ action: 'entered', type: 'geofence_red' }),
    );
  });

  it('emite alert:warning (no critical) al entrar en una geocerca "warning"', async () => {
    findMatchingSpatial.mockResolvedValue([warningCircleRow]);
    await service.evaluate(pos());

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      7,
      'alert:warning',
      expect.objectContaining({ type: 'geofence_yellow' }),
    );
    expect(socketServer.broadcastToProject).not.toHaveBeenCalledWith(
      7,
      'alert:critical',
      expect.anything(),
    );
  });

  it('no re-emite mientras el vehículo permanece en la misma severidad (sin cambio de estado)', async () => {
    findMatchingSpatial.mockResolvedValue([dangerCircleRow]);
    await service.evaluate(pos());
    socketServer.broadcastToProject.mockClear();
    await service.evaluate(pos());
    expect(socketServer.broadcastToProject).not.toHaveBeenCalled();
  });

  it('emite alert:clear al salir de la geocerca', async () => {
    findMatchingSpatial.mockResolvedValue([dangerCircleRow]);
    await service.evaluate(pos());
    socketServer.broadcastToProject.mockClear();
    findMatchingSpatial.mockResolvedValue([]);
    await service.evaluate(pos());

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      7,
      'alert:clear',
      expect.objectContaining({ deviceId: 'V1' }),
    );
    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      7,
      'supervisor:alert',
      expect.objectContaining({ action: 'exited' }),
    );
  });

  it('danger tiene prioridad sobre warning cuando el vehículo está en ambas a la vez', async () => {
    findMatchingSpatial.mockResolvedValue([warningCircleRow, { ...dangerCircleRow, id: 3 }]);
    await service.evaluate(pos());

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(7, 'alert:critical', expect.anything());
    expect(socketServer.broadcastToProject).not.toHaveBeenCalledWith(
      7,
      'alert:warning',
      expect.anything(),
    );
  });

  it('polilínea: severidad progresiva por distancia, no el binario dentro/fuera', async () => {
    findMatchingSpatial.mockResolvedValue([corridorRow(5)]);
    await service.evaluate(pos());
    expect(socketServer.broadcastToProject).not.toHaveBeenCalled();

    findMatchingSpatial.mockResolvedValue([corridorRow(500)]);
    await service.evaluate(pos());
    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(7, 'alert:warning', expect.anything());
  });

  it('polilínea: escala a danger al superar el margen configurado', async () => {
    findMatchingSpatial.mockResolvedValue([corridorRow(500, 100)]);
    await service.evaluate(pos());
    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(7, 'alert:critical', expect.anything());
  });

  it('_persistEvent es fire-and-forget vía geofenceEventRepo si se provee', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const withRepo = new GeofenceAlertService({
      geofenceRepo: { findMatchingSpatial: vi.fn().mockResolvedValue([dangerCircleRow]) },
      socketServer,
      geofenceEventRepo: { record },
    });
    await withRepo.evaluate(pos());

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'V1',
        geofenceId: dangerCircleRow.id,
        eventType: 'enter',
        severity: 'danger',
      }),
    );
  });

  it('emite alert:info (sin loop) al entrar en una geocerca "parking", sin sonar como warning/danger', async () => {
    findMatchingSpatial.mockResolvedValue([parkingCircleRow]);
    await service.evaluate(pos());

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      7,
      'alert:info',
      expect.objectContaining({
        type: 'geofence_parking',
        geofenceId: parkingCircleRow.id,
        message: 'ZONA DE ESTACIONAMIENTO',
        loop: false,
      }),
    );
    expect(socketServer.broadcastToProject).not.toHaveBeenCalledWith(
      7,
      'alert:warning',
      expect.anything(),
    );
    expect(socketServer.broadcastToProject).not.toHaveBeenCalledWith(
      7,
      'alert:critical',
      expect.anything(),
    );
  });

  it('warning tiene prioridad sobre "parking" cuando el vehículo está en ambas a la vez', async () => {
    findMatchingSpatial.mockResolvedValue([{ ...parkingCircleRow, id: 6 }, warningCircleRow]);
    await service.evaluate(pos());

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(7, 'alert:warning', expect.anything());
    expect(socketServer.broadcastToProject).not.toHaveBeenCalledWith(
      7,
      'alert:info',
      expect.anything(),
    );
  });

  it('_persistEvent registra severity "info" para geocercas de estacionamiento', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const withRepo = new GeofenceAlertService({
      geofenceRepo: { findMatchingSpatial: vi.fn().mockResolvedValue([parkingCircleRow]) },
      socketServer,
      geofenceEventRepo: { record },
    });
    await withRepo.evaluate(pos());

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'enter', severity: 'info' }),
    );
  });

  it('getActiveAlerts refleja el estado actual por dispositivo', async () => {
    findMatchingSpatial.mockResolvedValue([dangerCircleRow]);
    await service.evaluate(pos());
    expect(service.getActiveAlerts()).toEqual({ V1: 'danger' });
  });

  it('clearDevice limpia una alerta activa y notifica al proyecto correspondiente', async () => {
    findMatchingSpatial.mockResolvedValue([dangerCircleRow]);
    await service.evaluate(pos('V1', 9));
    socketServer.broadcastToProject.mockClear();

    service.clearDevice('V1', 9);

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      9,
      'alert:clear',
      expect.objectContaining({ deviceId: 'V1' }),
    );
    expect(service.getActiveAlerts().V1).toBeUndefined();
  });

  it('no emite nada si socketServer todavía no se asignó (dependencia circular con FleetSocketServer)', async () => {
    const withoutSocket = new GeofenceAlertService({
      geofenceRepo: { findMatchingSpatial: vi.fn().mockResolvedValue([dangerCircleRow]) },
    });
    await expect(withoutSocket.evaluate(pos())).resolves.not.toThrow();
  });

  it('emite alert:critical con mensaje propio (no el genérico de peligro) al entrar en "forbidden"', async () => {
    findMatchingSpatial.mockResolvedValue([forbiddenPolygonRow]);
    await service.evaluate(pos());

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      7,
      'alert:critical',
      expect.objectContaining({
        type: 'geofence_forbidden',
        message: expect.stringContaining('ZONA PROHIBIDA'),
        loop: true,
      }),
    );
  });

  it('emite alert:warning con mensaje propio (no el genérico de advertencia) al entrar en "maintenance"', async () => {
    findMatchingSpatial.mockResolvedValue([maintenancePolygonRow]);
    await service.evaluate(pos());

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      7,
      'alert:warning',
      expect.objectContaining({
        type: 'geofence_maintenance',
        message: expect.stringContaining('MANTENIMIENTO'),
      }),
    );
  });

  it('no emite ninguna alerta al entrar en "allowed" (puramente informativa)', async () => {
    findMatchingSpatial.mockResolvedValue([allowedPolygonRow]);
    await service.evaluate(pos());
    expect(socketServer.broadcastToProject).not.toHaveBeenCalled();
  });

  it('no emite ninguna alerta al entrar en "discharge" (puramente informativa)', async () => {
    findMatchingSpatial.mockResolvedValue([dischargePolygonRow]);
    await service.evaluate(pos());
    expect(socketServer.broadcastToProject).not.toHaveBeenCalled();
  });

  it('evaluate devuelve las geocercas encontradas (para que SpeedAlertService las reutilice)', async () => {
    findMatchingSpatial.mockResolvedValue([warningCircleRow]);
    const matches = await service.evaluate(pos());
    expect(matches).toEqual([warningCircleRow]);
  });

  it('emite alert:info al salir de una zona "allowed" (evento puntual, no un estado sostenido)', async () => {
    findMatchingSpatial.mockResolvedValue([allowedPolygonRow]);
    await service.evaluate(pos());
    socketServer.broadcastToProject.mockClear();

    findMatchingSpatial.mockResolvedValue([]);
    await service.evaluate(pos());

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      7,
      'alert:info',
      expect.objectContaining({ type: 'geofence_left_allowed', deviceId: 'V1' }),
    );
  });

  it('no emite el evento de salida de "allowed" si nunca estuvo dentro', async () => {
    findMatchingSpatial.mockResolvedValue([]);
    await service.evaluate(pos());
    expect(socketServer.broadcastToProject).not.toHaveBeenCalledWith(
      7,
      'alert:info',
      expect.objectContaining({ type: 'geofence_left_allowed' }),
    );
  });

  it('no re-emite el evento de salida de "allowed" en cada tick posterior fuera de la zona', async () => {
    findMatchingSpatial.mockResolvedValue([allowedPolygonRow]);
    await service.evaluate(pos());
    findMatchingSpatial.mockResolvedValue([]);
    await service.evaluate(pos());
    socketServer.broadcastToProject.mockClear();

    await service.evaluate(pos());
    expect(socketServer.broadcastToProject).not.toHaveBeenCalledWith(
      7,
      'alert:info',
      expect.objectContaining({ type: 'geofence_left_allowed' }),
    );
  });

  it('"forbidden" tiene la misma prioridad que "danger" - gana sobre "maintenance" (nivel advertencia)', async () => {
    findMatchingSpatial.mockResolvedValue([maintenancePolygonRow, forbiddenPolygonRow]);
    await service.evaluate(pos());

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(7, 'alert:critical', expect.anything());
    expect(socketServer.broadcastToProject).not.toHaveBeenCalledWith(
      7,
      'alert:warning',
      expect.anything(),
    );
  });
});
