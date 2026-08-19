import type { LineString, Polygon } from 'geojson';

export type GeofenceType = 'warning' | 'danger' | 'parking';
export type GeofenceShapeType = 'circle' | 'polygon' | 'polyline';

interface GeofenceBase {
  id: number;
  name: string;
  type: GeofenceType;
  projectId: number | null;
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
  corridorDangerMarginMeters?: number;
}

export type Geofence = CircleGeofence | PolygonGeofence | PolylineGeofence;

export type CorridorSeverity = 'warning' | 'danger' | null;
