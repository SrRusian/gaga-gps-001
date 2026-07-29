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
   *   - polyline: geometry (GeoJSON LineString), corridorWidthMeters
   */
  async create({ name, type, shapeType = 'circle', centerLat, centerLon, radiusMeters, geometry, corridorWidthMeters }) {
    try {
      const { rows } = await query(
        `INSERT INTO geofences
           (name, type, shape_type, center_lat, center_lon, radius_meters, geometry, corridor_width_meters)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          name, type, shapeType,
          centerLat ?? null, centerLon ?? null, radiusMeters ?? null,
          geometry ? JSON.stringify(geometry) : null,
          corridorWidthMeters ?? null
        ]
      );
      return rows[0];
    } catch (err) {
      console.error('❌ GeofenceRepository.create:', err.message);
      throw err;
    }
  }

  async update(id, { name, type, centerLat, centerLon, radiusMeters, active }) {
    try {
      const { rows } = await query(
        `UPDATE geofences SET
           name = COALESCE($2, name),
           type = COALESCE($3, type),
           center_lat = COALESCE($4, center_lat),
           center_lon = COALESCE($5, center_lon),
           radius_meters = COALESCE($6, radius_meters),
           active = COALESCE($7, active)
         WHERE id = $1 RETURNING *`,
        [id, name, type, centerLat, centerLon, radiusMeters, active]
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
      return { ...base, geometry: row.geometry, corridorWidthMeters: row.corridor_width_meters };
    }
    // polygon
    return { ...base, geometry: row.geometry };
  }
}

module.exports = GeofenceRepository;

