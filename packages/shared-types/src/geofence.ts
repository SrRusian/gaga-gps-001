import type { LineString, Polygon } from 'geojson';

export type GeofenceType =
  | 'warning'
  | 'danger'
  | 'parking'
  | 'forbidden'
  | 'authorized_route'
  | 'allowed'
  | 'discharge'
  | 'maintenance'
  | 'carga';
export type GeofenceShapeType = 'circle' | 'polygon' | 'polyline';

interface GeofenceBase {
  id: number;
  name: string;
  type: GeofenceType;
  projectId: number | null;
  // limite de velocidad de la zona, si tiene. Viaja hasta la tableta a proposito: desde el
  // rediseño de "la tableta evalua, el servidor registra", el exceso de velocidad lo decide el
  // propio Operador con los limites que ya tiene en mano, sin depender de ida y vuelta al servidor
  speedLimitKmh?: number | null;
}

export interface CircleGeofence extends GeofenceBase {
  shapeType: 'circle';
  center: { lat: number; lon: number };
  radiusMeters: number;
}

export interface PolygonGeofence extends GeofenceBase {
  shapeType: 'polygon';
  geometry: Polygon;
  // false = "sin relleno" - alerta por cercania al borde (reusa corridorWidthMeters como umbral
  // unico de deteccion) en vez de area completa. La severidad la decide siempre el `type`
  // (GeofenceAlertService.AREA_SEVERITY), no la distancia.
  filled: boolean;
  corridorWidthMeters?: number;
}

export interface PolylineGeofence extends GeofenceBase {
  shapeType: 'polyline';
  geometry: LineString;
  corridorWidthMeters: number;
  // true (default, comportamiento historico de "Ruta autorizada") = debe permanecer DENTRO del
  // ancho; false = "no tocar" - alerta al ACERCARSE al ancho de la linea. En ambos casos la
  // severidad la decide el `type`, no la distancia.
  stayInside: boolean;
}

export type Geofence = CircleGeofence | PolygonGeofence | PolylineGeofence;
