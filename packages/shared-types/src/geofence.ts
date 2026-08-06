import type { LineString, Polygon } from 'geojson';

export type GeofenceType = 'warning' | 'danger';
export type GeofenceShapeType = 'circle' | 'polygon' | 'polyline';

interface GeofenceBase {
  id: number;
  name: string;
  type: GeofenceType;
}

export interface CircleGeofence extends GeofenceBase {
  shapeType: 'circle';
  center: { lat: number; lon: number };
  radiusMeters: number;
}

export interface PolygonGeofence extends GeofenceBase {
  shapeType: 'polygon';
  geometry: Polygon;
}

export interface PolylineGeofence extends GeofenceBase {
  shapeType: 'polyline';
  geometry: LineString;
  corridorWidthMeters: number;
  /** Opcional — sin esto, salir del corredor siempre es "warning" (binario), nunca escala a "danger". */
  corridorDangerMarginMeters?: number;
}

/**
 * Forma normalizada en memoria de una geocerca — la que produce
 * GeofenceRepository.toMemoryFormat() a partir de una fila de
 * PostgreSQL, y la que evalúan GeofenceAlertService/geometry.ts.
 * Es también la forma que viaja por la API y por Socket.io
 * (evento `geofences:update`) hacia las 3 apps web.
 */
export type Geofence = CircleGeofence | PolygonGeofence | PolylineGeofence;

export type CorridorSeverity = 'warning' | 'danger' | null;
