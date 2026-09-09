import type { Geofence } from '@gaga-gps/shared-types';
import type { LineString, Polygon } from 'geojson';
import type { GeofenceRow } from './types';

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
      stayInside: row.stay_inside,
    };
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    projectId: row.project_id,
    shapeType: 'polygon',
    geometry: row.geometry as Polygon,
    filled: row.filled,
    corridorWidthMeters: row.corridor_width_meters ?? undefined,
  };
}
