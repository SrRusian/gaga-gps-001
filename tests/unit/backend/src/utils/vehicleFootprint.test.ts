import { describe, expect, it } from 'vitest';
import {
  buildVehicleFootprintWkt,
  destinationPoint,
  VehicleHeadingTracker,
} from '../../../../../backend/src/utils/vehicleFootprint';

describe('destinationPoint', () => {
  it('rumbo 0 (norte): aumenta la latitud, la longitud no cambia', () => {
    const p = destinationPoint(0, 0, 0, 1000);
    expect(p.lat).toBeGreaterThan(0);
    expect(p.lon).toBeCloseTo(0, 6);
  });

  it('rumbo 180 (sur): disminuye la latitud, la longitud no cambia', () => {
    const p = destinationPoint(0, 0, 180, 1000);
    expect(p.lat).toBeLessThan(0);
    expect(p.lon).toBeCloseTo(0, 6);
  });

  it('rumbo 90 (este) desde el ecuador: aumenta la longitud, la latitud no cambia', () => {
    const p = destinationPoint(0, 0, 90, 1000);
    expect(p.lon).toBeGreaterThan(0);
    expect(p.lat).toBeCloseTo(0, 6);
  });

  it('rumbo 270 (oeste) desde el ecuador: disminuye la longitud, la latitud no cambia', () => {
    const p = destinationPoint(0, 0, 270, 1000);
    expect(p.lon).toBeLessThan(0);
    expect(p.lat).toBeCloseTo(0, 6);
  });

  it('distancia 0 devuelve el mismo punto', () => {
    const p = destinationPoint(19.35, -103.56, 45, 0);
    expect(p.lat).toBeCloseTo(19.35, 6);
    expect(p.lon).toBeCloseTo(-103.56, 6);
  });
});

describe('buildVehicleFootprintWkt', () => {
  it('devuelve un WKT POLYGON con 5 puntos y el anillo cerrado (primero = ultimo)', () => {
    const wkt = buildVehicleFootprintWkt(19.35, -103.56, 0, 10, 4);
    expect(wkt.startsWith('POLYGON((')).toBe(true);
    const coordsText = wkt.slice('POLYGON(('.length, -2);
    const points = coordsText.split(', ');
    expect(points).toHaveLength(5);
    expect(points[0]).toBe(points[4]);
  });

  it('rumbo 0: el rectangulo es mas largo en el eje norte-sur que en el este-oeste para un vehiculo largo/angosto', () => {
    const wkt = buildVehicleFootprintWkt(0, 0, 0, 10, 2);
    const points = wkt
      .slice('POLYGON(('.length, -2)
      .split(', ')
      .map((p) => p.split(' ').map(Number));
    const lats = points.map((p) => p[1]);
    const lons = points.map((p) => p[0]);
    const latSpread = Math.max(...lats) - Math.min(...lats);
    const lonSpread = Math.max(...lons) - Math.min(...lons);
    // con rumbo norte, el largo (10m) corre en latitud y el ancho (2m) en longitud
    expect(latSpread).toBeGreaterThan(lonSpread);
  });
});

describe('VehicleHeadingTracker', () => {
  it('sin ningun fix confiable todavia, devuelve null', () => {
    const tracker = new VehicleHeadingTracker();
    expect(tracker.resolveTrustedCourse('T1', 90, 0)).toBeNull();
  });

  it('a velocidad suficiente, adopta el rumbo reportado', () => {
    const tracker = new VehicleHeadingTracker();
    expect(tracker.resolveTrustedCourse('T1', 45, 10)).toBe(45);
  });

  it('a baja velocidad, congela el ultimo rumbo confiable en vez de adoptar uno nuevo ruidoso', () => {
    const tracker = new VehicleHeadingTracker();
    tracker.resolveTrustedCourse('T1', 45, 10);
    const frozen = tracker.resolveTrustedCourse('T1', 300, 0.5);
    expect(frozen).toBe(45);
  });

  it('clearDevice olvida el rumbo confiable de ese dispositivo', () => {
    const tracker = new VehicleHeadingTracker();
    tracker.resolveTrustedCourse('T1', 45, 10);
    tracker.clearDevice('T1');
    expect(tracker.resolveTrustedCourse('T1', undefined, 0)).toBeNull();
  });

  it('rumbo indefinido a velocidad alta no pisa el estado (sin dato valido que adoptar)', () => {
    const tracker = new VehicleHeadingTracker();
    tracker.resolveTrustedCourse('T1', 45, 10);
    const stillFrozen = tracker.resolveTrustedCourse('T1', undefined, 20);
    expect(stillFrozen).toBe(45);
  });
});
