import { describe, expect, it } from 'vitest';
import type { LineString, Polygon } from 'geojson';
import type { CircleGeofence, Geofence, PolygonGeofence, PolylineGeofence } from '@gaga-gps/shared-types';
import * as geometry from './geometry';

const GEOFENCE_BASE = { id: 1, name: 'test', type: 'warning' as const, projectId: null };

function circleGeofence(
  center: { lat: number; lon: number },
  radiusMeters: number,
): CircleGeofence {
  return { ...GEOFENCE_BASE, shapeType: 'circle', center, radiusMeters };
}

function polygonGeofence(geometry: Polygon): PolygonGeofence {
  return { ...GEOFENCE_BASE, shapeType: 'polygon', geometry };
}

function polylineGeofence(
  geometry: LineString,
  corridorWidthMeters: number,
  corridorDangerMarginMeters?: number,
): PolylineGeofence {
  return { ...GEOFENCE_BASE, shapeType: 'polyline', geometry, corridorWidthMeters, corridorDangerMarginMeters };
}

describe('haversineDistance', () => {
  it('devuelve 0 para el mismo punto', () => {
    expect(geometry.haversineDistance(19.35, -103.56, 19.35, -103.56)).toBe(0);
  });

  it('calcula ~111.2km por cada grado de latitud en el ecuador', () => {
    const d = geometry.haversineDistance(0, 0, 1, 0);
    expect(d).toBeGreaterThan(110500);
    expect(d).toBeLessThan(111500);
  });
});

describe('isPointInPolygon', () => {
  const square: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [-103.6, 19.3],
        [-103.5, 19.3],
        [-103.5, 19.4],
        [-103.6, 19.4],
        [-103.6, 19.3],
      ],
    ],
  };

  it('detecta un punto dentro del polígono', () => {
    expect(geometry.isPointInPolygon(19.35, -103.55, square)).toBe(true);
  });

  it('detecta un punto fuera del polígono', () => {
    expect(geometry.isPointInPolygon(19.35, -103.9, square)).toBe(false);
  });
});

describe('distancePointToLineMeters', () => {
  const line: LineString = {
    type: 'LineString',
    coordinates: [
      [-103.6, 19.3],
      [-103.5, 19.3],
    ],
  };

  it('devuelve ~0 para un punto sobre la línea', () => {
    expect(geometry.distancePointToLineMeters(19.3, -103.55, line)).toBeLessThan(1);
  });

  it('calcula la distancia perpendicular a un punto fuera de la línea', () => {
    const d = geometry.distancePointToLineMeters(19.31, -103.55, line);
    expect(d).toBeGreaterThan(1000);
    expect(d).toBeLessThan(1200);
  });
});

describe('isInsideGeofence', () => {
  it('círculo - dentro del radio', () => {
    const geofence = circleGeofence({ lat: 19.35, lon: -103.56 }, 100);
    expect(geometry.isInsideGeofence(19.35, -103.56, geofence)).toBe(true);
  });

  it('círculo - justo en el borde (<=) cuenta como dentro', () => {
    const center = { lat: 19.35, lon: -103.56 };
    const geofence = circleGeofence(center, 100);
    const oneDegLat = 111320;
    const dLat = 100 / oneDegLat;
    const edgePoint = { lat: center.lat + dLat, lon: center.lon };
    const distance = geometry.haversineDistance(
      edgePoint.lat,
      edgePoint.lon,
      center.lat,
      center.lon,
    );
    expect(distance).toBeCloseTo(100, 0);
    expect(geometry.isInsideGeofence(edgePoint.lat, edgePoint.lon, geofence)).toBe(true);
  });

  it('círculo - fuera del radio', () => {
    const geofence = circleGeofence({ lat: 19.35, lon: -103.56 }, 10);
    expect(geometry.isInsideGeofence(19.4, -103.56, geofence)).toBe(false);
  });

  it('default sin shapeType se trata como círculo', () => {
    const geofence = { center: { lat: 19.35, lon: -103.56 }, radiusMeters: 100 } as unknown as Geofence;
    expect(geometry.isInsideGeofence(19.35, -103.56, geofence)).toBe(true);
  });

  it('polígono delega en isPointInPolygon', () => {
    const geofence = polygonGeofence({
      type: 'Polygon',
      coordinates: [
        [
          [-103.6, 19.3],
          [-103.5, 19.3],
          [-103.5, 19.4],
          [-103.6, 19.4],
          [-103.6, 19.3],
        ],
      ],
    });
    expect(geometry.isInsideGeofence(19.35, -103.55, geofence)).toBe(true);
    expect(geometry.isInsideGeofence(19.35, -103.9, geofence)).toBe(false);
  });

  it('polilínea - dentro del ancho del corredor cuenta como dentro', () => {
    const geofence = polylineGeofence(
      {
        type: 'LineString',
        coordinates: [
          [-103.6, 19.3],
          [-103.5, 19.3],
        ],
      },
      50,
    );
    expect(geometry.isInsideGeofence(19.3, -103.55, geofence)).toBe(true);
  });
});

describe('getCorridorSeverity', () => {
  const corridorLine: LineString = {
    type: 'LineString',
    coordinates: [
      [-103.6, 19.3],
      [-103.5, 19.3],
    ],
  };
  const geofence = {
    corridorWidthMeters: 50,
    corridorDangerMarginMeters: 30,
    geometry: corridorLine,
  };

  it('null cuando está dentro del ancho del corredor', () => {
    expect(geometry.getCorridorSeverity(19.3, -103.55, geofence)).toBeNull();
  });

  it('"warning" entre el ancho del corredor y el margen de peligro', () => {
    const oneDegLat = 111320;
    const lat = 19.3 + 65 / oneDegLat;
    expect(geometry.getCorridorSeverity(lat, -103.55, geofence)).toBe('warning');
  });

  it('"danger" más allá del margen de peligro', () => {
    const oneDegLat = 111320;
    const lat = 19.3 + 200 / oneDegLat;
    expect(geometry.getCorridorSeverity(lat, -103.55, geofence)).toBe('danger');
  });

  it('sin corridorDangerMarginMeters configurado, nunca escala a "danger" (binario)', () => {
    const geofenceSinMargen = {
      corridorWidthMeters: 50,
      geometry: geofence.geometry,
    };
    const oneDegLat = 111320;
    const lat = 19.3 + 5000 / oneDegLat; // muy lejos del eje
    expect(geometry.getCorridorSeverity(lat, -103.55, geofenceSinMargen)).toBe('warning');
  });
});
