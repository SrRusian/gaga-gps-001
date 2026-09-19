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
  // true = el vehiculo ya toca/esta adentro (circle/polygon filled) - comportamiento de siempre,
  // alerta critica inmediata. false = cerca pero todavia no toca (solo circle/polygon filled, via
  // el buffer de proximidad) - GeofenceAlertService evalua el tier elastico (silencioso/urgente).
  // polyline y polygon sin relleno siempre vienen en true - conservan su severidad fija de siempre,
  // sin tiering por distancia (ya la decide el propio WHERE con corridor_width_meters).
  contained: boolean;
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
    footprintWkt = null,
    accuracyMeters = 0,
    alertableTypes = [],
    proximityLookaheadMeters = 0,
  }: {
    projectId: number | null;
    latitude: number;
    longitude: number;
    // rectangulo orientado real del vehiculo (ver backend/src/utils/vehicleFootprint.ts), agrandado
    // por la precision GPS actual (ST_Buffer) - null si el dispositivo no tiene tipo de vehiculo
    // asignado o rumbo confiable todavia, en cuyo caso se usa el punto crudo de siempre SIN buffer
    // (cero regresion para esos dispositivos, comportamiento identico al de antes de esta feature)
    footprintWkt?: string | null;
    accuracyMeters?: number;
    // tipos con severidad real (AREA_SEVERITY en GeofenceAlertService, fuente unica de verdad) -
    // solo estos ganan el buffer de proximidad extra para el aviso elastico; vacio = comportamiento
    // identico al de antes (ningun match nuevo, solo los 5 casos de siempre)
    alertableTypes?: string[];
    proximityLookaheadMeters?: number;
  }): Promise<GeofenceMatchRow[]> {
    try {
      // La severidad de cada match la decide siempre el `type` en GeofenceAlertService
      // (AREA_SEVERITY) - aqui solo se decide SI una geocerca aplica, segun su forma/relleno/modo,
      // contra una geometria de prueba `fp` (el rectangulo del vehiculo si hay uno, si no el punto
      // crudo, igual que siempre):
      //  - circle: dentro del radio (ST_DWithin) + buffer de proximidad si el tipo es alertable
      //  - polygon filled=true: toca/adentro (ST_Intersects) + buffer de proximidad si es alertable
      //  - polygon filled=false: cerca del borde (ST_DWithin contra ST_Boundary, un solo umbral)
      //  - polyline stay_inside=true, tipo != authorized_route ("debe quedarse dentro"): FUERA del
      //    ancho de la linea
      //  - polyline stay_inside=false ("no tocar"): cerca de la linea (ST_DWithin, un solo umbral)
      //  - polyline type=authorized_route (sin importar stay_inside - nunca alerta, no tiene entrada
      //    en AREA_SEVERITY): DENTRO del corredor - el unico proposito de que "matchee" es que su
      //    speed_limit_kmh llegue a SpeedAlertService mientras el vehiculo va sobre la ruta. La
      //    membresia de ruta para el sistema de colision/distancia entre vehiculos es una consulta
      //    aparte (findRouteMembership), no depende de este WHERE.
      // `contained` distingue "ya toca" (circle/polygon filled dentro del umbral base, sin el buffer
      // extra) de "cerca pero todavia no" (solo alcanzable via el buffer de proximidad) - polyline y
      // polygon sin relleno siempre contained=true, conservan su severidad fija de siempre.
      const { rows } = await query<GeofenceMatchRow>(
        `WITH fp AS (
           SELECT CASE
             WHEN $4::text IS NOT NULL THEN ST_Buffer(ST_GeogFromText($4), COALESCE($5::double precision, 0))
             ELSE ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography
           END AS g
         )
         SELECT g.id, g.name, g.type, g.shape_type, g.speed_limit_kmh,
                CASE
                  WHEN g.shape_type = 'polygon' AND g.filled = FALSE
                    THEN ST_Distance(ST_Boundary(g.geog::geometry)::geography, fp.g)
                  WHEN g.shape_type = 'circle'
                    THEN GREATEST(ST_Distance(g.geog, fp.g) - g.radius_meters, 0)
                  ELSE ST_Distance(g.geog, fp.g)
                END AS distance_meters,
                CASE
                  WHEN g.shape_type = 'circle' THEN ST_DWithin(g.geog, fp.g, g.radius_meters)
                  WHEN g.shape_type = 'polygon' AND g.filled = TRUE
                    THEN ST_Intersects(g.geog::geometry, fp.g::geometry)
                  ELSE TRUE
                END AS contained
         FROM geofences g, fp
         WHERE g.active = TRUE
           AND g.project_id = $1
           AND (
             (g.shape_type = 'circle' AND ST_DWithin(g.geog, fp.g, g.radius_meters
               + CASE WHEN g.type = ANY($6::text[]) THEN $7 ELSE 0 END))
             OR (g.shape_type = 'polygon' AND g.filled = TRUE AND (
                   ST_Intersects(g.geog::geometry, fp.g::geometry)
                   OR (g.type = ANY($6::text[])
                       AND ST_DWithin(ST_Boundary(g.geog::geometry)::geography, fp.g, $7))
                 ))
             OR (g.shape_type = 'polygon' AND g.filled = FALSE
                 AND ST_DWithin(ST_Boundary(g.geog::geometry)::geography, fp.g, g.corridor_width_meters))
             OR (g.shape_type = 'polyline' AND g.stay_inside = TRUE AND g.type <> 'authorized_route'
                 AND NOT ST_DWithin(g.geog, fp.g, g.corridor_width_meters))
             OR (g.shape_type = 'polyline' AND g.stay_inside = FALSE
                 AND ST_DWithin(g.geog, fp.g, g.corridor_width_meters))
             OR (g.shape_type = 'polyline' AND g.type = 'authorized_route'
                 AND ST_DWithin(g.geog, fp.g, g.corridor_width_meters))
           )`,
        [
          projectId,
          latitude,
          longitude,
          footprintWkt,
          accuracyMeters,
          alertableTypes,
          proximityLookaheadMeters,
        ],
      );
      return rows;
    } catch (err) {
      console.error('GeofenceRepository.findMatchingSpatial:', (err as Error).message);
      throw err;
    }
  }

  // "¿en que ruta autorizada esta este punto, y en que fraccion de su recorrido (0=inicio, 1=fin)?"
  // - independiente del WHERE de alerta de findMatchingSpatial (una ruta "stay_inside=true" normal
  // NO aparece ahi mientras el vehiculo va bien, solo cuando se sale) - CollisionRiskService lo usa
  // para saber si dos vehiculos van por la misma ruta y en que direccion (fraccion creciente vs
  // decreciente), ST_LineLocatePoint es justo para esto. Si el punto cae en mas de una ruta a la vez
  // (poco comun), se queda con la mas cercana.
  async findRouteMembership({
    projectId,
    latitude,
    longitude,
  }: {
    projectId: number | null;
    latitude: number;
    longitude: number;
  }): Promise<{ id: number; name: string; corridorWidthMeters: number; lineFraction: number } | null> {
    try {
      const { rows } = await query<{
        id: number;
        name: string;
        corridor_width_meters: number;
        line_fraction: number;
      }>(
        `SELECT g.id, g.name, g.corridor_width_meters,
                ST_LineLocatePoint(g.geog::geometry, pt.g::geometry) AS line_fraction
         FROM geofences g,
              LATERAL (SELECT ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography AS g) pt
         WHERE g.active = TRUE AND g.project_id = $1
           AND g.shape_type = 'polyline' AND g.type = 'authorized_route'
           AND ST_DWithin(g.geog, pt.g, g.corridor_width_meters)
         ORDER BY ST_Distance(g.geog, pt.g) ASC
         LIMIT 1`,
        [projectId, latitude, longitude],
      );
      if (!rows[0]) return null;
      return {
        id: rows[0].id,
        name: rows[0].name,
        corridorWidthMeters: rows[0].corridor_width_meters,
        lineFraction: rows[0].line_fraction,
      };
    } catch (err) {
      console.error('GeofenceRepository.findRouteMembership:', (err as Error).message);
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
    // el limite de la zona viaja al Operador: es el quien evalua el exceso de velocidad ahora
    const speedLimitKmh = row.speed_limit_kmh ?? null;

    if (shapeType === 'circle') {
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        projectId: row.project_id,
        shapeType: 'circle',
        speedLimitKmh,
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
        speedLimitKmh,
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
      speedLimitKmh,
      geometry: row.geometry as import('geojson').Polygon,
      filled: row.filled,
      corridorWidthMeters: row.corridor_width_meters ?? undefined,
    };
  }
}

export default GeofenceRepository;
