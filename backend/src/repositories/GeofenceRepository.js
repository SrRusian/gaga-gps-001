/**
 * GeofenceRepository.js
 *
 * Responsabilidad: CRUD de geocercas en PostgreSQL — soporta tres
 * formas: círculo (compatibilidad original), polígono y polilínea
 * (ruta/corredor autorizado). Ver db/migrations/003_geofence_shapes.sql.
 *
 * Sustituye la gestión en memoria — GeofenceAlertService sigue
 * evaluando en memoria, pero su lista se hidrata desde aquí.
 */

const { query } = require('../config/database');

class GeofenceRepository {

  async findAllActive() {
    try {
      const { rows } = await query(
        'SELECT * FROM geofences WHERE active = TRUE ORDER BY id ASC'
      );
      return rows;
    } catch (err) {
      console.error('❌ GeofenceRepository.findAllActive:', err.message);
      throw err;
    }
  }

  /**
   * Subconjunto de geocercas por id — usado por la exportación
   * selectiva de GeoJSON/KML (ver geofences.routes.js).
   */
  async findByIds(ids) {
    try {
      const { rows } = await query(
        'SELECT * FROM geofences WHERE active = TRUE AND id = ANY($1) ORDER BY id ASC',
        [ids]
      );
      return rows;
    } catch (err) {
      console.error('❌ GeofenceRepository.findByIds:', err.message);
      throw err;
    }
  }

  async findById(id) {
    try {
      const { rows } = await query('SELECT * FROM geofences WHERE id = $1', [id]);
      return rows[0] || null;
    } catch (err) {
      console.error('❌ GeofenceRepository.findById:', err.message);
      throw err;
    }
  }

  /**
   * Crea una geocerca de cualquier forma.
   * @param {Object} params
   *   - shapeType: 'circle' | 'polygon' | 'polyline' (default 'circle')
   *   - name, type ('warning'|'danger')
   *   - circle: centerLat, centerLon, radiusMeters
   *   - polygon: geometry (GeoJSON Polygon)
   *   - polyline: geometry (GeoJSON LineString), corridorWidthMeters,
   *     corridorDangerMarginMeters (opcional — ver getCorridorSeverity)
   */
  async create({ name, type, shapeType = 'circle', centerLat, centerLon, radiusMeters, geometry, corridorWidthMeters, corridorDangerMarginMeters }) {
    try {
      const { rows } = await query(
        `INSERT INTO geofences
           (name, type, shape_type, center_lat, center_lon, radius_meters, geometry, corridor_width_meters, corridor_danger_margin_meters)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          name, type, shapeType,
          centerLat ?? null, centerLon ?? null, radiusMeters ?? null,
          geometry ? JSON.stringify(geometry) : null,
          corridorWidthMeters ?? null,
          corridorDangerMarginMeters ?? null
        ]
      );
      return rows[0];
    } catch (err) {
      console.error('❌ GeofenceRepository.create:', err.message);
      throw err;
    }
  }

  /**
   * Edita una geocerca existente — no cambia su forma (shape_type),
   * solo sus parámetros: nombre/tipo/estado siempre, y según la
   * forma: radio y centro (círculo), geometría (polígono/ruta),
   * ancho y margen de peligro (ruta).
   */
  async update(id, { name, type, active, centerLat, centerLon, radiusMeters, geometry, corridorWidthMeters, corridorDangerMarginMeters }) {
    try {
      const { rows } = await query(
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
          id, name, type, active,
          centerLat ?? null, centerLon ?? null, radiusMeters ?? null,
          geometry ? JSON.stringify(geometry) : null,
          corridorWidthMeters ?? null,
          corridorDangerMarginMeters ?? null
        ]
      );
      return rows[0] || null;
    } catch (err) {
      console.error('❌ GeofenceRepository.update:', err.message);
      throw err;
    }
  }

  async delete(id) {
    try {
      await query('DELETE FROM geofences WHERE id = $1', [id]);
      return true;
    } catch (err) {
      console.error('❌ GeofenceRepository.delete:', err.message);
      throw err;
    }
  }

  /**
   * Convierte una fila de PostgreSQL al formato en memoria que
   * espera GeofenceAlertService.addGeofence() — un único lugar
   * para esta conversión, usado tanto al hidratar al arrancar
   * (app.js) como al crear una geocerca vía API (geofences.routes.js).
   */
  static toMemoryFormat(row) {
    const base = {
      id: row.id,
      name: row.name,
      type: row.type,
      shapeType: row.shape_type || 'circle'
    };

    if (base.shapeType === 'circle') {
      return { ...base, center: { lat: row.center_lat, lon: row.center_lon }, radiusMeters: row.radius_meters };
    }
    if (base.shapeType === 'polyline') {
      return {
        ...base,
        geometry: row.geometry,
        corridorWidthMeters: row.corridor_width_meters,
        corridorDangerMarginMeters: row.corridor_danger_margin_meters
      };
    }
    // polygon
    return { ...base, geometry: row.geometry };
  }
}

module.exports = GeofenceRepository;

