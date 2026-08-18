import type { Geofence } from '@gaga-gps/shared-types';
import type { LineString, Polygon } from 'geojson';
import type { GeofenceRow } from './types';

/**
 * Convierte una fila cruda de /api/geofences (snake_case) a la forma
 * normalizada que espera @gaga-gps/map-core (mismo mapeo que
 * GeofenceRepository.toMemoryFormat en el backend) - así Admin
 * reutiliza el mismo hook de renderizado que Operador/Supervisor en
 * vez de tener su propia cuarta copia.
 */
export function toGeofence(row: GeofenceRow): Geofence {
  if (row.shape_type === 'circle') {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      projectId: row.project_id,
      shapeType: 'circle',
      center: { lat: row.center_lat as number, lon: row.center_lon as number },
      radiusMeters: row.radius_meters as number,
    };
  }
  if (row.shape_type === 'polyline') {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      projectId: row.project_id,
      shapeType: 'polyline',
      geometry: row.geometry as LineString,
      corridorWidthMeters: row.corridor_width_meters as number,
      corridorDangerMarginMeters: row.corridor_danger_margin_meters ?? undefined,
    };
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    projectId: row.project_id,
    shapeType: 'polygon',
    geometry: row.geometry as Polygon,
  };
}
