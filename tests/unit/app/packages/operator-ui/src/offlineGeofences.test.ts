import { describe, expect, it } from 'vitest';
import type { Geofence } from '@gaga-gps/shared-types';
import { evaluateGeofencesOffline } from '../../../../../../app/packages/operator-ui/src/offlineGeofences';

// cuadrado de ~222m de lado centrado en (19.35, -103.56) - 0.001 grados son ~111m
const CENTER = { lat: 19.35, lon: -103.56 };
const SQUARE: number[][] = [
  [-103.561, 19.349],
  [-103.559, 19.349],
  [-103.559, 19.351],
  [-103.561, 19.351],
  [-103.561, 19.349],
];

function polygon(over: Partial<Geofence> = {}): Geofence {
  return {
    id: 1,
    name: 'Zona',
    type: 'danger',
    projectId: null,
    shapeType: 'polygon',
    geometry: { type: 'Polygon', coordinates: [SQUARE] },
    filled: true,
    ...over,
  } as Geofence;
}

function line(over: Partial<Geofence> = {}): Geofence {
  return {
    id: 2,
    name: 'Linea',
    type: 'danger',
    projectId: null,
    shapeType: 'polyline',
    geometry: { type: 'LineString', coordinates: [[-103.561, 19.35], [-103.559, 19.35]] },
    corridorWidthMeters: 50,
    stayInside: true,
    ...over,
  } as Geofence;
}

describe('evaluateGeofencesOffline', () => {
  it('poligono con relleno: alerta dentro, nada fuera', () => {
    const inside = evaluateGeofencesOffline(CENTER.lat, CENTER.lon, [polygon()]);
    expect(inside?.severity).toBe('danger');
    expect(inside?.message).toContain('DETENER');
    expect(evaluateGeofencesOffline(19.36, CENTER.lon, [polygon()])).toBeNull();
  });

  it('circulo: alerta dentro del radio, nada fuera', () => {
    const circle = {
      id: 3, name: 'Circulo', type: 'warning', projectId: null,
      shapeType: 'circle', center: CENTER, radiusMeters: 100,
    } as Geofence;
    expect(evaluateGeofencesOffline(19.3505, CENTER.lon, [circle])?.severity).toBe('warning');
    expect(evaluateGeofencesOffline(19.352, CENTER.lon, [circle])).toBeNull();
  });

  it('poligono sin relleno: alerta cerca del borde, no en el centro', () => {
    const unfilled = polygon({ filled: false, corridorWidthMeters: 60 } as Partial<Geofence>);
    expect(evaluateGeofencesOffline(19.3505, CENTER.lon, [unfilled])).not.toBeNull();
    expect(evaluateGeofencesOffline(CENTER.lat, CENTER.lon, [unfilled])).toBeNull();
  });

  it('linea "debe quedarse dentro": alerta al SALIR del ancho', () => {
    expect(evaluateGeofencesOffline(CENTER.lat, -103.56, [line()])).toBeNull();
    expect(evaluateGeofencesOffline(19.351, -103.56, [line()])).not.toBeNull();
  });

  it('linea "no tocar": alerta al ENTRAR al ancho (sentido inverso)', () => {
    const noTouch = line({ stayInside: false } as Partial<Geofence>);
    expect(evaluateGeofencesOffline(CENTER.lat, -103.56, [noTouch])).not.toBeNull();
    expect(evaluateGeofencesOffline(19.351, -103.56, [noTouch])).toBeNull();
  });

  it('tipos informativos nunca alertan, ni estando dentro', () => {
    for (const type of ['allowed', 'discharge', 'carga', 'authorized_route'] as const) {
      expect(evaluateGeofencesOffline(CENTER.lat, CENTER.lon, [polygon({ type })])).toBeNull();
    }
  });

  it('con varias geocercas encima gana la de mayor severidad', () => {
    const zones = [
      polygon({ id: 10, type: 'warning', name: 'Precaucion' }),
      polygon({ id: 11, type: 'danger', name: 'Peligro' }),
    ];
    const match = evaluateGeofencesOffline(CENTER.lat, CENTER.lon, zones);
    expect(match?.severity).toBe('danger');
    expect(match?.geofenceId).toBe(11);
  });

  it('un agujero del poligono no cuenta como dentro', () => {
    const withHole = polygon({
      geometry: {
        type: 'Polygon',
        coordinates: [SQUARE, [
          [-103.5605, 19.3495], [-103.5595, 19.3495],
          [-103.5595, 19.3505], [-103.5605, 19.3505], [-103.5605, 19.3495],
        ]],
      },
    } as Partial<Geofence>);
    expect(evaluateGeofencesOffline(CENTER.lat, CENTER.lon, [withHole])).toBeNull();
  });
});
