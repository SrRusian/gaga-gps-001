import { beforeEach, describe, expect, it, vi } from 'vitest';
import GeofenceAlertService, { type GeofenceMatchRow } from '../../../../../../backend/src/services/alerts/GeofenceAlertService';

// La severidad SIEMPRE la decide `type` (AREA_SEVERITY/AREA_ALERT_TEXT) - shape_type/filled/
// stay_inside/corridor_width_meters ya no viajan hasta aca, esos deciden SI una fila aparece en
// `matches` (responsabilidad de GeofenceRepository.findMatchingSpatial, cubierto en su propio
// integration test contra Postgres real) - aqui solo importa el `type` de lo que ya matcheo.
const dangerCircleRow = {
  id: 1,
  name: 'Zona Roja',
  type: 'danger' as const,
  shape_type: 'circle' as const,
  speed_limit_kmh: null,
  distance_meters: 10,
};

const warningCircleRow = {
  id: 2,
  name: 'Zona Amarilla',
  type: 'warning' as const,
  shape_type: 'circle' as const,
  speed_limit_kmh: null,
  distance_meters: 10,
};

const parkingCircleRow = {
  id: 5,
  name: 'Estacionamiento Norte',
  type: 'parking' as const,
  shape_type: 'circle' as const,
  speed_limit_kmh: null,
  distance_meters: 10,
};

const forbiddenPolygonRow = {
  id: 7,
  name: 'Polvorín',
  type: 'forbidden' as const,
  shape_type: 'polygon' as const,
  speed_limit_kmh: null,
  distance_meters: 10,
};

const maintenancePolygonRow = {
  id: 8,
  name: 'Reparación de talud',
  type: 'maintenance' as const,
  shape_type: 'polygon' as const,
  speed_limit_kmh: null,
  distance_meters: 10,
};

const allowedPolygonRow = {
  id: 9,
  name: 'Patio de maniobras',
  type: 'allowed' as const,
  shape_type: 'polygon' as const,
  speed_limit_kmh: null,
  distance_meters: 10,
};

const dischargePolygonRow = {
  id: 10,
  name: 'Tolva',
  type: 'discharge' as const,
  shape_type: 'polygon' as const,
  speed_limit_kmh: null,
  distance_meters: 10,
};

// mismo type que antes usaba escalada por distancia (corridorSeverityFromDistance) - ahora tiene
// severidad fija 'warning' y mensaje propio, sin importar la forma (polyline, o polygon sin
// relleno) ni la distancia real - eso ya lo filtro el WHERE de findMatchingSpatial
const authorizedRouteRow = {
  id: 4,
  name: 'Ruta autorizada',
  type: 'authorized_route' as const,
  shape_type: 'polyline' as const,
  speed_limit_kmh: null,
  distance_meters: 10,
};

function pos(deviceId = 'V1', projectId: number | null = 7) {
  return { deviceId, latitude: 19.35, longitude: -103.56, projectId };
}

type FindMatchingSpatial = (params: {
  projectId: number | null;
  latitude: number;
  longitude: number;
  footprintWkt?: string | null;
  accuracyMeters?: number;
  alertableTypes?: string[];
  proximityLookaheadMeters?: number;
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

  it('consulta findMatchingSpatial con el proyecto, coordenadas y contexto de proximidad', async () => {
    await service.evaluate(pos('V1', 7));
    expect(findMatchingSpatial).toHaveBeenCalledWith({
      projectId: 7,
      latitude: 19.35,
      longitude: -103.56,
      footprintWkt: null,
      accuracyMeters: 0,
      alertableTypes: expect.arrayContaining(['danger', 'forbidden', 'warning', 'maintenance']),
      proximityLookaheadMeters: expect.any(Number),
    });
  });

  it('el buffer de proximidad nunca incluye "parking" (info, puramente informativa)', async () => {
    await service.evaluate(pos('V1', 7));
    const call = findMatchingSpatial.mock.calls[0][0];
    expect(call.alertableTypes).not.toContain('parking');
  });

  it('el buffer de proximidad nunca incluye "authorized_route" (ya no genera alerta alguna)', async () => {
    await service.evaluate(pos('V1', 7));
    const call = findMatchingSpatial.mock.calls[0][0];
    expect(call.alertableTypes).not.toContain('authorized_route');
  });

  it('pasa el footprintWkt/accuracy de la posicion cuando vienen presentes', async () => {
    await service.evaluate({ ...pos('V1', 7), footprintWkt: 'POLYGON((0 0,0 0,0 0,0 0,0 0))', accuracy: 3 });
    expect(findMatchingSpatial).toHaveBeenCalledWith(
      expect.objectContaining({ footprintWkt: 'POLYGON((0 0,0 0,0 0,0 0,0 0))', accuracyMeters: 3 }),
    );
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

  // fuera de AREA_SEVERITY a proposito - salir de una ruta autorizada ya no es un problema, solo
  // aporta limite de velocidad (findMatchingSpatial) y sirve de referencia para el sistema de
  // distancia entre vehiculos (findRouteMembership, consulta completamente aparte)
  it('"authorized_route" nunca genera ninguna alerta', async () => {
    findMatchingSpatial.mockResolvedValue([authorizedRouteRow]);
    await service.evaluate(pos());
    expect(socketServer.broadcastToProject).not.toHaveBeenCalled();
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

  // "zona permitida" (allowed) ahora es el limite operativo real (ej. contorno de la mina) - solo
  // dispara algo si el DISPOSITIVO esta marcado restringido (devices.restricted_to_allowed_zone,
  // ver PositionProcessor). Uno sin restriccion (default) entra/sale libre, sin ningun aviso.
  describe('zona permitida restringida (devices.restricted_to_allowed_zone)', () => {
    it('un dispositivo SIN restriccion no genera ninguna alerta al salir de "allowed"', async () => {
      findMatchingSpatial.mockResolvedValue([allowedPolygonRow]);
      await service.evaluate(pos());
      socketServer.broadcastToProject.mockClear();

      findMatchingSpatial.mockResolvedValue([]);
      await service.evaluate(pos());

      expect(socketServer.broadcastToProject).not.toHaveBeenCalled();
    });

    it('un dispositivo RESTRINGIDO genera alert:critical + infraccion al salir de "allowed"', async () => {
      const create = vi.fn().mockResolvedValue(undefined);
      const withRepo = new GeofenceAlertService({
        geofenceRepo: {
          findMatchingSpatial: vi
            .fn()
            .mockResolvedValueOnce([allowedPolygonRow])
            .mockResolvedValueOnce([]),
        },
        socketServer,
        infractionRepo: { create },
      });
      await withRepo.evaluate({ ...pos(), restrictedToAllowedZone: true });
      await withRepo.evaluate({ ...pos(), restrictedToAllowedZone: true });

      expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
        7,
        'alert:critical',
        expect.objectContaining({
          type: 'restricted_zone_violation',
          message: expect.stringContaining('FUERA DE ZONA PERMITIDA'),
          loop: true,
        }),
      );
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: 'V1', infractionType: 'geofence' }),
      );
    });

    it('un dispositivo RESTRINGIDO recibe alert:clear al regresar a "allowed"', async () => {
      const withRepo = new GeofenceAlertService({
        geofenceRepo: {
          findMatchingSpatial: vi
            .fn()
            .mockResolvedValueOnce([allowedPolygonRow])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([allowedPolygonRow]),
        },
        socketServer,
        infractionRepo: { create: vi.fn().mockResolvedValue(undefined) },
      });
      await withRepo.evaluate({ ...pos(), restrictedToAllowedZone: true });
      await withRepo.evaluate({ ...pos(), restrictedToAllowedZone: true });
      socketServer.broadcastToProject.mockClear();

      await withRepo.evaluate({ ...pos(), restrictedToAllowedZone: true });

      expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
        7,
        'alert:clear',
        expect.objectContaining({ deviceId: 'V1' }),
      );
    });

    it('no dispara nada si nunca estuvo dentro de "allowed" (sin importar restriccion)', async () => {
      findMatchingSpatial.mockResolvedValue([]);
      await service.evaluate({ ...pos(), restrictedToAllowedZone: true });
      expect(socketServer.broadcastToProject).not.toHaveBeenCalled();
    });

    it('no re-emite la alerta en cada tick posterior fuera de la zona (restringido)', async () => {
      const withRepo = new GeofenceAlertService({
        geofenceRepo: {
          findMatchingSpatial: vi
            .fn()
            .mockResolvedValueOnce([allowedPolygonRow])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]),
        },
        socketServer,
        infractionRepo: { create: vi.fn().mockResolvedValue(undefined) },
      });
      await withRepo.evaluate({ ...pos(), restrictedToAllowedZone: true });
      await withRepo.evaluate({ ...pos(), restrictedToAllowedZone: true });
      socketServer.broadcastToProject.mockClear();

      await withRepo.evaluate({ ...pos(), restrictedToAllowedZone: true });
      expect(socketServer.broadcastToProject).not.toHaveBeenCalled();
    });
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

  describe('proximidad elastica (tiers silencioso/urgente) - contained: false', () => {
    it('tier silencioso: solo sendToDevice (nunca broadcastToProject), nunca se registra', async () => {
      const sendToDevice = vi.fn();
      const broadcastToProject = vi.fn();
      const recordOrEscalate = vi.fn().mockResolvedValue(undefined);
      const create = vi.fn().mockResolvedValue(undefined);
      const withRepo = new GeofenceAlertService({
        geofenceRepo: {
          findMatchingSpatial: vi
            .fn()
            .mockResolvedValueOnce([{ ...dangerCircleRow, contained: false, distance_meters: 10 }])
            .mockResolvedValueOnce([{ ...dangerCircleRow, contained: false, distance_meters: 3 }]),
        },
        socketServer: { broadcastToProject, sendToDevice },
        alertEventRepo: { recordOrEscalate, resolveOpen: vi.fn().mockResolvedValue(undefined) },
        infractionRepo: { create },
      });
      await withRepo.evaluate(pos());
      await withRepo.evaluate(pos());

      expect(sendToDevice).toHaveBeenCalledWith(
        'V1',
        'alert:proximity_notice',
        expect.objectContaining({ geofenceId: dangerCircleRow.id, deviceId: 'V1' }),
      );
      expect(broadcastToProject).not.toHaveBeenCalled();
      expect(recordOrEscalate).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    it('tier urgente: mismo canal que la critica de siempre, mensaje de proximidad, SI se registra', async () => {
      const recordOrEscalate = vi.fn().mockResolvedValue(undefined);
      const create = vi.fn().mockResolvedValue(undefined);
      const broadcastToProject = vi.fn();
      const withRepo = new GeofenceAlertService({
        geofenceRepo: {
          findMatchingSpatial: vi
            .fn()
            .mockResolvedValueOnce([{ ...dangerCircleRow, contained: false, distance_meters: 5 }])
            .mockResolvedValueOnce([{ ...dangerCircleRow, contained: false, distance_meters: 1 }]),
        },
        socketServer: { broadcastToProject },
        alertEventRepo: { recordOrEscalate, resolveOpen: vi.fn().mockResolvedValue(undefined) },
        infractionRepo: { create },
      });
      await withRepo.evaluate(pos());
      await withRepo.evaluate(pos());

      expect(broadcastToProject).toHaveBeenCalledWith(
        7,
        'alert:critical',
        expect.objectContaining({ message: expect.stringContaining('ACERCÁNDOSE') }),
      );
      expect(recordOrEscalate).toHaveBeenCalledWith(expect.objectContaining({ severity: 'danger' }));
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          infractionType: 'geofence',
          metadata: expect.objectContaining({ proximity: true }),
        }),
      );
    });

    it('sin convergencia (distancia estable) no dispara ningun tier de proximidad', async () => {
      const sendToDevice = vi.fn();
      const broadcastToProject = vi.fn();
      const withRepo = new GeofenceAlertService({
        geofenceRepo: {
          findMatchingSpatial: vi
            .fn()
            .mockResolvedValueOnce([{ ...dangerCircleRow, contained: false, distance_meters: 3 }])
            .mockResolvedValueOnce([{ ...dangerCircleRow, contained: false, distance_meters: 3 }]),
        },
        socketServer: { broadcastToProject, sendToDevice },
      });
      await withRepo.evaluate(pos());
      await withRepo.evaluate(pos());

      expect(broadcastToProject).not.toHaveBeenCalled();
      expect(sendToDevice).not.toHaveBeenCalled();
    });

    it('clearDevice limpia un aviso silencioso activo (sendToDevice proximity_clear)', async () => {
      const sendToDevice = vi.fn();
      const withRepo = new GeofenceAlertService({
        geofenceRepo: {
          findMatchingSpatial: vi
            .fn()
            .mockResolvedValueOnce([{ ...dangerCircleRow, contained: false, distance_meters: 10 }])
            .mockResolvedValueOnce([{ ...dangerCircleRow, contained: false, distance_meters: 3 }]),
        },
        socketServer: { broadcastToProject: vi.fn(), sendToDevice },
      });
      await withRepo.evaluate(pos());
      await withRepo.evaluate(pos());
      sendToDevice.mockClear();

      withRepo.clearDevice('V1', 7);

      expect(sendToDevice).toHaveBeenCalledWith(
        'V1',
        'alert:proximity_clear',
        expect.objectContaining({ deviceId: 'V1' }),
      );
    });
  });

  describe('infracciones (tabla `infractions`, permanente)', () => {
    it('el tier critico (ya tocando) crea una infraccion sin el flag de proximidad', async () => {
      const create = vi.fn().mockResolvedValue(undefined);
      const withRepo = new GeofenceAlertService({
        geofenceRepo: { findMatchingSpatial: vi.fn().mockResolvedValue([dangerCircleRow]) },
        socketServer,
        infractionRepo: { create },
      });
      await withRepo.evaluate(pos());

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          infractionType: 'geofence',
          latitude: 19.35,
          longitude: -103.56,
          metadata: expect.objectContaining({ proximity: false }),
        }),
      );
    });

    it('nunca crea infraccion para "parking" (severidad info, puramente informativa)', async () => {
      const create = vi.fn().mockResolvedValue(undefined);
      const withRepo = new GeofenceAlertService({
        geofenceRepo: { findMatchingSpatial: vi.fn().mockResolvedValue([parkingCircleRow]) },
        socketServer,
        infractionRepo: { create },
      });
      await withRepo.evaluate(pos());
      expect(create).not.toHaveBeenCalled();
    });

    it('no re-crea la infraccion en cada tick mientras se mantiene en la misma severidad', async () => {
      const create = vi.fn().mockResolvedValue(undefined);
      const withRepo = new GeofenceAlertService({
        geofenceRepo: { findMatchingSpatial: vi.fn().mockResolvedValue([dangerCircleRow]) },
        socketServer,
        infractionRepo: { create },
      });
      await withRepo.evaluate(pos());
      await withRepo.evaluate(pos());
      expect(create).toHaveBeenCalledTimes(1);
    });
  });
});
