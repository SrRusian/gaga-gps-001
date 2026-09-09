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
  speedLimitKmh?: number;
  filled?: boolean;
  stayInside?: boolean;
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
  speedLimitKmh?: number | null;
  filled?: boolean;
  stayInside?: boolean;
}

// solo lo que GeofenceAlertService realmente consume - la severidad/mensaje siempre los decide el
// `type` (AREA_SEVERITY/AREA_ALERT_TEXT), asi que shape_type/filled/stay_inside/corridor_width_meters
// ya no viajan hasta alla: el WHERE de findMatchingSpatial es quien decide si una fila "matchea"
export interface GeofenceMatchRow {
  id: number;
  name: string;
  type: GeofenceType;
  shape_type: GeofenceShapeType;
  speed_limit_kmh: number | null;
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
      // La severidad de cada match la decide siempre el `type` en GeofenceAlertService
      // (AREA_SEVERITY) - aqui solo se decide SI una geocerca aplica en este punto, segun su
      // forma/relleno/modo:
      //  - circle: dentro del radio (ST_DWithin, sin cambios)
      //  - polygon filled=true: adentro de la zona completa (ST_Contains, sin cambios)
      //  - polygon filled=false: cerca del borde (ST_DWithin contra ST_Boundary, un solo umbral)
      //  - polyline stay_inside=true ("debe quedarse dentro"): FUERA del ancho de la linea
      //  - polyline stay_inside=false ("no tocar"): cerca de la linea (ST_DWithin, un solo umbral)
      const { rows } = await query<GeofenceMatchRow>(
        `SELECT g.id, g.name, g.type, g.shape_type, g.speed_limit_kmh,
                CASE
                  WHEN g.shape_type = 'polygon' AND g.filled = FALSE
                    THEN ST_Distance(ST_Boundary(g.geog::geometry)::geography, pt.g)
                  ELSE ST_Distance(g.geog, pt.g)
                END AS distance_meters
         FROM geofences g,
              LATERAL (SELECT ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography AS g) pt
         WHERE g.active = TRUE
           AND g.project_id = $1
           AND (
             (g.shape_type = 'circle' AND ST_DWithin(g.geog, pt.g, g.radius_meters))
             OR (g.shape_type = 'polygon' AND g.filled = TRUE AND ST_Contains(g.geog::geometry, pt.g::geometry))
             OR (g.shape_type = 'polygon' AND g.filled = FALSE
                 AND ST_DWithin(ST_Boundary(g.geog::geometry)::geography, pt.g, g.corridor_width_meters))
             OR (g.shape_type = 'polyline' AND g.stay_inside = TRUE
                 AND NOT ST_DWithin(g.geog, pt.g, g.corridor_width_meters))
             OR (g.shape_type = 'polyline' AND g.stay_inside = FALSE
                 AND ST_DWithin(g.geog, pt.g, g.corridor_width_meters))
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
    speedLimitKmh,
    filled,
    stayInside,
  }: CreateGeofenceParams): Promise<GeofenceRow> {
    try {
      const { rows } = await query<GeofenceRow>(
        `INSERT INTO geofences
           (name, project_id, type, shape_type, center_lat, center_lon, radius_meters, geometry, corridor_width_meters, speed_limit_kmh, filled, stay_inside, geog)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
           CASE $13
             WHEN 'circle' THEN ST_SetSRID(ST_MakePoint($6, $5), 4326)::geography
             ELSE ST_GeomFromGeoJSON($14)::geography
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
          speedLimitKmh ?? null,
          filled ?? true,
          stayInside ?? true,
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
      speedLimitKmh,
      filled,
      stayInside,
    } = params;

    // SET armado a mano para los campos que un PATCH parcial puede querer cambiar de verdad
    // (type ahora se edita seguido desde el selector de 8 tipos) - COALESCE no distingue "no vino
    // en el body" de "vino como valor real". center/geometria/geog se quedan con COALESCE con
    // fallback a la columna actual como ya funcionaba - no hay caso real de "limpiar" la forma de
    // una geocerca via PATCH (el shape se recrea, no se edita).
    const sets: string[] = [];
    const values: unknown[] = [id];
    if (name !== undefined) {
      values.push(name);
      sets.push(`name = $${values.length}`);
    }
    if (type !== undefined) {
      values.push(type);
      sets.push(`type = $${values.length}`);
    }
    if (active !== undefined) {
      values.push(active);
      sets.push(`active = $${values.length}`);
    }
    if (radiusMeters !== undefined) {
      values.push(radiusMeters);
      sets.push(`radius_meters = $${values.length}`);
    }
    if (corridorWidthMeters !== undefined) {
      values.push(corridorWidthMeters);
      sets.push(`corridor_width_meters = $${values.length}`);
    }
    if (filled !== undefined) {
      values.push(filled);
      sets.push(`filled = $${values.length}`);
    }
    if (stayInside !== undefined) {
      values.push(stayInside);
      sets.push(`stay_inside = $${values.length}`);
    }
    if (speedLimitKmh !== undefined) {
      values.push(speedLimitKmh);
      sets.push(`speed_limit_kmh = $${values.length}`);
    }

    values.push(centerLon ?? null);
    const centerLonIdx = values.length;
    values.push(centerLat ?? null);
    const centerLatIdx = values.length;
    values.push(geometry ? JSON.stringify(geometry) : null);
    const geometryIdx = values.length;

    sets.push(`center_lat = COALESCE($${centerLatIdx}, center_lat)`);
    sets.push(`center_lon = COALESCE($${centerLonIdx}, center_lon)`);
    sets.push(`geometry = COALESCE($${geometryIdx}, geometry)`);
    sets.push(`geog = CASE shape_type
      WHEN 'circle' THEN ST_SetSRID(ST_MakePoint(COALESCE($${centerLonIdx}, center_lon), COALESCE($${centerLatIdx}, center_lat)), 4326)::geography
      ELSE ST_GeomFromGeoJSON(COALESCE($${geometryIdx}, geometry)::text)::geography
    END`);

    try {
      const { rows } = await query<GeofenceRow>(
        `UPDATE geofences SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        values,
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
        stayInside: row.stay_inside,
      };
    }
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      projectId: row.project_id,
      shapeType: 'polygon',
      geometry: row.geometry as import('geojson').Polygon,
      filled: row.filled,
      corridorWidthMeters: row.corridor_width_meters ?? undefined,
    };
  }
}

export default GeofenceRepository;
