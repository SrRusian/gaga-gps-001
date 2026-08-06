// Test de caracterización — congela el comportamiento actual ANTES
// de convertir a TypeScript.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GeofenceAlertService from './GeofenceAlertService';

const dangerCircle = {
  id: 1,
  name: 'Zona Roja',
  type: 'danger',
  center: { lat: 19.35, lon: -103.56 },
  radiusMeters: 50,
};

const warningCircle = {
  id: 2,
  name: 'Zona Amarilla',
  type: 'warning',
  center: { lat: 19.4, lon: -103.6 },
  radiusMeters: 50,
};

function pos(lat: number, lon: number, deviceId = 'V1') {
  return { deviceId, latitude: lat, longitude: lon };
}

describe('GeofenceAlertService', () => {
  let io: { emit: ReturnType<typeof vi.fn> };
  let service: InstanceType<typeof GeofenceAlertService>;

  beforeEach(() => {
    io = { emit: vi.fn() };
    service = new GeofenceAlertService({ io });
  });

  it('addGeofence normaliza shapeType a "circle" por default', () => {
    service.addGeofence({
      id: 1,
      name: 'X',
      type: 'warning',
      center: { lat: 0, lon: 0 },
      radiusMeters: 10,
    });
    expect(service.activeGeofences[0].shapeType).toBe('circle');
  });

  it('addGeofence reemplaza una geocerca existente con el mismo id en vez de duplicarla', () => {
    service.addGeofence(dangerCircle);
    service.addGeofence({ ...dangerCircle, name: 'Renombrada' });
    expect(service.activeGeofences).toHaveLength(1);
    expect(service.activeGeofences[0].name).toBe('Renombrada');
  });

  it('removeGeofence la quita de las activas', () => {
    service.addGeofence(dangerCircle);
    service.removeGeofence(dangerCircle.id);
    expect(service.activeGeofences).toHaveLength(0);
  });

  it('no emite nada mientras el vehículo está fuera de todas las geocercas', () => {
    service.addGeofence(dangerCircle);
    service.evaluate(pos(0, 0));
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('emite alert:critical + supervisor:alert al entrar en una geocerca "danger"', () => {
    service.addGeofence(dangerCircle);
    service.evaluate(pos(19.35, -103.56));

    expect(io.emit).toHaveBeenCalledWith(
      'alert:critical',
      expect.objectContaining({ type: 'geofence_red', deviceId: 'V1', loop: true }),
    );
    expect(io.emit).toHaveBeenCalledWith(
      'supervisor:alert',
      expect.objectContaining({ action: 'entered', type: 'geofence_red' }),
    );
  });

  it('emite alert:warning (no critical) al entrar en una geocerca "warning"', () => {
    service.addGeofence(warningCircle);
    service.evaluate(pos(19.4, -103.6));

    expect(io.emit).toHaveBeenCalledWith(
      'alert:warning',
      expect.objectContaining({ type: 'geofence_yellow' }),
    );
    expect(io.emit).not.toHaveBeenCalledWith('alert:critical', expect.anything());
  });

  it('no re-emite mientras el vehículo permanece en la misma severidad (sin cambio de estado)', () => {
    service.addGeofence(dangerCircle);
    service.evaluate(pos(19.35, -103.56));
    io.emit.mockClear();
    service.evaluate(pos(19.35, -103.56)); // sigue dentro, misma severidad
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('emite alert:clear al salir de la geocerca', () => {
    service.addGeofence(dangerCircle);
    service.evaluate(pos(19.35, -103.56));
    io.emit.mockClear();
    service.evaluate(pos(0, 0));

    expect(io.emit).toHaveBeenCalledWith(
      'alert:clear',
      expect.objectContaining({ deviceId: 'V1' }),
    );
    expect(io.emit).toHaveBeenCalledWith(
      'supervisor:alert',
      expect.objectContaining({ action: 'exited' }),
    );
  });

  it('danger tiene prioridad sobre warning cuando el vehículo está en ambas a la vez', () => {
    service.addGeofence(warningCircle);
    service.addGeofence({ ...dangerCircle, id: 3, center: warningCircle.center, radiusMeters: 50 });
    service.evaluate(pos(19.4, -103.6));

    expect(io.emit).toHaveBeenCalledWith('alert:critical', expect.anything());
    expect(io.emit).not.toHaveBeenCalledWith('alert:warning', expect.anything());
  });

  it('polilínea: severidad progresiva vía getCorridorSeverity, no el binario dentro/fuera', () => {
    const corridor = {
      id: 4,
      name: 'Ruta autorizada',
      type: 'warning',
      shapeType: 'polyline',
      corridorWidthMeters: 20,
      geometry: {
        type: 'LineString',
        coordinates: [
          [-103.6, 19.3],
          [-103.5, 19.3],
        ],
      },
    };
    service.addGeofence(corridor);
    // Dentro del corredor -> sin alerta
    service.evaluate(pos(19.3, -103.55));
    expect(io.emit).not.toHaveBeenCalled();

    // Lejos del eje -> warning (sin corridorDangerMarginMeters, nunca escala a danger)
    const oneDegLat = 111320;
    service.evaluate(pos(19.3 + 500 / oneDegLat, -103.55));
    expect(io.emit).toHaveBeenCalledWith('alert:warning', expect.anything());
  });

  it('_persistEvent es fire-and-forget vía geofenceEventRepo si se provee', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const withRepo = new GeofenceAlertService({ io, geofenceEventRepo: { record } });
    withRepo.addGeofence(dangerCircle);
    withRepo.evaluate(pos(19.35, -103.56));

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'V1',
        geofenceId: dangerCircle.id,
        eventType: 'enter',
        severity: 'danger',
      }),
    );
  });

  it('getActiveAlerts refleja el estado actual por dispositivo', () => {
    service.addGeofence(dangerCircle);
    service.evaluate(pos(19.35, -103.56));
    expect(service.getActiveAlerts()).toEqual({ V1: 'danger' });
  });
});
