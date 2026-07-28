/**
 * GeofenceRepository.js
 *
 * Responsabilidad: CRUD de geocercas en PostgreSQL.
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

  async create({ name, type, centerLat, centerLon, radiusMeters }) {
    try {
      const { rows } = await query(
        `INSERT INTO geofences (name, type, center_lat, center_lon, radius_meters)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [name, type, centerLat, centerLon, radiusMeters]
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
}

module.exports = GeofenceRepository;
