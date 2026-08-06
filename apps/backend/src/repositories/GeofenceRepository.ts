/**
 * GeofenceRepository.ts
 *
 * Responsabilidad: CRUD de geocercas en PostgreSQL — soporta tres
 * formas: círculo (compatibilidad original), polígono y polilínea
 * (ruta/corredor autorizado). Ver db/migrations/003_geofence_shapes.sql.
 *
 * Sustituye la gestión en memoria — GeofenceAlertService sigue
 * evaluando en memoria, pero su lista se hidrata desde aquí.
 */
import type { Geofence, GeofenceShapeType, GeofenceType } from '@gaga-gps/shared-types';
import type { LineString, Polygon } from 'geojson';
import { query } from '../config/database';
import type { GeofenceRow } from '../utils/geoFormats';

export interface CreateGeofenceParams {
  name: string;
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

class GeofenceRepository {
  async findAllActive(): Promise<GeofenceRow[]> {
    try {
      const { rows } = await query<GeofenceRow>(
        'SELECT * FROM geofences WHERE active = TRUE ORDER BY id ASC',
      );
      return rows;
    } catch (err) {
      console.error('❌ GeofenceRepository.findAllActive:', (err as Error).message);
      throw err;
    }
  }

  /**
   * Subconjunto de geocercas por id — usado por la exportación
   * selectiva de GeoJSON/KML (ver geofences.routes.js).
   */
  async findByIds(ids: number[]): Promise<GeofenceRow[]> {
    try {
      const { rows } = await query<GeofenceRow>(
        'SELECT * FROM geofences WHERE active = TRUE AND id = ANY($1) ORDER BY id ASC',
        [ids],
      );
      return rows;
    } catch (err) {
      console.error('❌ GeofenceRepository.findByIds:', (err as Error).message);
      throw err;
    }
  }

  async findById(id: number): Promise<GeofenceRow | null> {
    try {
      const { rows } = await query<GeofenceRow>('SELECT * FROM geofences WHERE id = $1', [id]);
      return rows[0] || null;
    } catch (err) {
      console.error('❌ GeofenceRepository.findById:', (err as Error).message);
      throw err;
    }
  }

  /**
   * Crea una geocerca de cualquier forma.
   *   - shapeType: 'circle' | 'polygon' | 'polyline' (default 'circle')
   *   - circle: centerLat, centerLon, radiusMeters
   *   - polygon: geometry (GeoJSON Polygon)
   *   - polyline: geometry (GeoJSON LineString), corridorWidthMeters,
   *     corridorDangerMarginMeters (opcional — ver getCorridorSeverity)
   */
  async create({
    name,
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
           (name, type, shape_type, center_lat, center_lon, radius_meters, geometry, corridor_width_meters, corridor_danger_margin_meters)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          name,
          type,
          shapeType,
          centerLat ?? null,
          centerLon ?? null,
          radiusMeters ?? null,
          geometry ? JSON.stringify(geometry) : null,
          corridorWidthMeters ?? null,
          corridorDangerMarginMeters ?? null,
        ],
      );
      return rows[0];
    } catch (err) {
      console.error('❌ GeofenceRepository.create:', (err as Error).message);
      throw err;
    }
  }

  /**
   * Edita una geocerca existente — no cambia su forma (shape_type),
   * solo sus parámetros: nombre/tipo/estado siempre, y según la
   * forma: radio y centro (círculo), geometría (polígono/ruta),
   * ancho y margen de peligro (ruta).
   */
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
           corridor_danger_margin_meters = COALESCE($10, corridor_danger_margin_meters)
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
      console.error('❌ GeofenceRepository.update:', (err as Error).message);
      throw err;
    }
  }

  async delete(id: number): Promise<true> {
    try {
      await query('DELETE FROM geofences WHERE id = $1', [id]);
      return true;
    } catch (err) {
      console.error('❌ GeofenceRepository.delete:', (err as Error).message);
      throw err;
    }
  }

  /**
   * Convierte una fila de PostgreSQL al formato en memoria que
   * espera GeofenceAlertService.addGeofence() — un único lugar
   * para esta conversión, usado tanto al hidratar al arrancar
   * (app.js) como al crear una geocerca vía API (geofences.routes.js).
   */
  static toMemoryFormat(row: GeofenceRow): Geofence {
    const shapeType = row.shape_type || 'circle';

    if (shapeType === 'circle') {
      return {
        id: row.id,
        name: row.name,
        type: row.type,
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
        shapeType: 'polyline',
        geometry: row.geometry as import('geojson').LineString,
        corridorWidthMeters: row.corridor_width_meters as number,
        corridorDangerMarginMeters: row.corridor_danger_margin_meters ?? undefined,
      };
    }
    // polygon
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      shapeType: 'polygon',
      geometry: row.geometry as import('geojson').Polygon,
    };
  }
}

export default GeofenceRepository;
