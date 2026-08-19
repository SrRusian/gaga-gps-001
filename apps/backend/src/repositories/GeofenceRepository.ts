import type { Geofence, GeofenceShapeType, GeofenceType } from '@gaga-gps/shared-types';
import type { LineString, Polygon } from 'geojson';
import { query } from '../config/database';
import type { GeofenceRow } from '../utils/geoFormats';

export interface CreateGeofenceParams {
  name: string;
  projectId: number | null;
  type: GeofenceType;
  shapeType?: GeofenceShapeType;
  centerLat?: number;
  centerLon?: number;
  radiusMeters?: number;
  geometry?: Polygon | LineString;
  corridorWidthMeters?: number;
  corridorDangerMarginMeters?: number;
}

export interface UpdateGeofenceParams {
  name?: string;
  type?: GeofenceType;
  active?: boolean;
  centerLat?: number;
  centerLon?: number;
  radiusMeters?: number;
  geometry?: Polygon | LineString;
  corridorWidthMeters?: number;
  corridorDangerMarginMeters?: number;
}

export interface GeofenceMatchRow {
  id: number;
  name: string;
  type: GeofenceType;
  shape_type: GeofenceShapeType;
  corridor_width_meters: number | null;
  corridor_danger_margin_meters: number | null;
  distance_meters: number;
}

class GeofenceRepository {
  async findAllActive(projectId?: number | null): Promise<GeofenceRow[]> {
    try {
      const { rows } =
        projectId != null
          ? await query<GeofenceRow>(
              'SELECT * FROM geofences WHERE active = TRUE AND project_id = $1 ORDER BY id ASC',
              [projectId],
            )
          : await query<GeofenceRow>('SELECT * FROM geofences WHERE active = TRUE ORDER BY id ASC');
      return rows;
    } catch (err) {
      console.error('GeofenceRepository.findAllActive:', (err as Error).message);
      throw err;
    }
  }

  async findByIds(ids: number[], projectId?: number | null): Promise<GeofenceRow[]> {
    try {
      const { rows } =
        projectId != null
          ? await query<GeofenceRow>(
              'SELECT * FROM geofences WHERE active = TRUE AND id = ANY($1) AND project_id = $2 ORDER BY id ASC',
              [ids, projectId],
            )
          : await query<GeofenceRow>(
              'SELECT * FROM geofences WHERE active = TRUE AND id = ANY($1) ORDER BY id ASC',
              [ids],
            );
      return rows;
    } catch (err) {
      console.error('GeofenceRepository.findByIds:', (err as Error).message);
      throw err;
    }
  }

  async findById(id: number): Promise<GeofenceRow | null> {
    try {
      const { rows } = await query<GeofenceRow>('SELECT * FROM geofences WHERE id = $1', [id]);
      return rows[0] || null;
    } catch (err) {
      console.error('GeofenceRepository.findById:', (err as Error).message);
      throw err;
    }
  }

  async findMatchingSpatial({
    projectId,
    latitude,
    longitude,
  }: {
    projectId: number | null;
    latitude: number;
    longitude: number;
  }): Promise<GeofenceMatchRow[]> {
    try {
      const { rows } = await query<GeofenceMatchRow>(
        `SELECT g.id, g.name, g.type, g.shape_type,
                g.corridor_width_meters, g.corridor_danger_margin_meters,
                ST_Distance(g.geog, pt.g) AS distance_meters
         FROM geofences g,
              LATERAL (SELECT ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography AS g) pt
         WHERE g.active = TRUE
           AND g.project_id = $1
           AND (
             (g.shape_type = 'circle' AND ST_DWithin(g.geog, pt.g, g.radius_meters))
             OR (g.shape_type = 'polygon' AND ST_Contains(g.geog::geometry, pt.g::geometry))
             OR (g.shape_type = 'polyline')
           )`,
        [projectId, latitude, longitude],
      );
      return rows;
    } catch (err) {
      console.error('GeofenceRepository.findMatchingSpatial:', (err as Error).message);
      throw err;
    }
  }

  async create({
    name,
    projectId,
    type,
    shapeType = 'circle',
    centerLat,
    centerLon,
    radiusMeters,
    geometry,
    corridorWidthMeters,
    corridorDangerMarginMeters,
  }: CreateGeofenceParams): Promise<GeofenceRow> {
    try {
      const { rows } = await query<GeofenceRow>(
        `INSERT INTO geofences
           (name, project_id, type, shape_type, center_lat, center_lon, radius_meters, geometry, corridor_width_meters, corridor_danger_margin_meters, geog)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
           CASE $11
             WHEN 'circle' THEN ST_SetSRID(ST_MakePoint($6, $5), 4326)::geography
             ELSE ST_GeomFromGeoJSON($12)::geography
           END)
         RETURNING *`,
        [
          name,
          projectId,
          type,
          shapeType,
          centerLat ?? null,
          centerLon ?? null,
          radiusMeters ?? null,
          geometry ? JSON.stringify(geometry) : null,
          corridorWidthMeters ?? null,
          corridorDangerMarginMeters ?? null,
          // duplican $4/$8 - mismo placeholder en dos contextos de tipo distinto confunde a pg
          shapeType,
          geometry ? JSON.stringify(geometry) : null,
        ],
      );
      return rows[0];
    } catch (err) {
      console.error('GeofenceRepository.create:', (err as Error).message);
      throw err;
    }
  }

  async update(id: number, params: UpdateGeofenceParams): Promise<GeofenceRow | null> {
    const {
      name,
      type,
      active,
      centerLat,
      centerLon,
      radiusMeters,
      geometry,
      corridorWidthMeters,
      corridorDangerMarginMeters,
    } = params;
    try {
      const { rows } = await query<GeofenceRow>(
        `UPDATE geofences SET
           name = COALESCE($2, name),
           type = COALESCE($3, type),
           active = COALESCE($4, active),
           center_lat = COALESCE($5, center_lat),
           center_lon = COALESCE($6, center_lon),
           radius_meters = COALESCE($7, radius_meters),
           geometry = COALESCE($8, geometry),
           corridor_width_meters = COALESCE($9, corridor_width_meters),
           corridor_danger_margin_meters = COALESCE($10, corridor_danger_margin_meters),
           geog = CASE shape_type
             WHEN 'circle' THEN ST_SetSRID(ST_MakePoint(COALESCE($6, center_lon), COALESCE($5, center_lat)), 4326)::geography
             ELSE ST_GeomFromGeoJSON(COALESCE($8, geometry)::text)::geography
           END
         WHERE id = $1 RETURNING *`,
        [
          id,
          name,
          type,
          active,
          centerLat ?? null,
          centerLon ?? null,
          radiusMeters ?? null,
          geometry ? JSON.stringify(geometry) : null,
          corridorWidthMeters ?? null,
          corridorDangerMarginMeters ?? null,
        ],
      );
      return rows[0] || null;
    } catch (err) {
      console.error('GeofenceRepository.update:', (err as Error).message);
      throw err;
    }
  }

  async delete(id: number): Promise<true> {
    try {
      await query('DELETE FROM geofences WHERE id = $1', [id]);
      return true;
    } catch (err) {
      console.error('GeofenceRepository.delete:', (err as Error).message);
      throw err;
    }
  }

  static toMemoryFormat(row: GeofenceRow): Geofence {
    const shapeType = row.shape_type || 'circle';

    if (shapeType === 'circle') {
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
    if (shapeType === 'polyline') {
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        projectId: row.project_id,
        shapeType: 'polyline',
        geometry: row.geometry as import('geojson').LineString,
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
      geometry: row.geometry as import('geojson').Polygon,
    };
  }
}

export default GeofenceRepository;
