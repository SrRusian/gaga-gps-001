/**
 * PositionRepository.js
 *
 * Responsabilidad: Persistencia de posiciones GPS en la
 * hypertable TimescaleDB `positions`, y consultas de historial
 * para reportes/replay.
 */

const { query } = require('../config/database');

class PositionRepository {

  /**
   * Guarda una posición normalizada
   * @param {Object} position - { deviceId, latitude, longitude, altitude,
   *   speed, course, accuracy, battery, fixTime, protocol, valid, attributes }
   */
  async save(position) {
    try {
      const { rows } = await query(
        `INSERT INTO positions
           (device_id, latitude, longitude, altitude, speed, course,
            accuracy, battery, fix_time, protocol, valid, attributes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          position.deviceId,
          position.latitude,
          position.longitude,
          position.altitude || 0,
          position.speed || 0,
          position.course || 0,
          position.accuracy || 0,
          position.battery ?? null,
          position.fixTime || new Date(),
          position.protocol || 'osmand',
          position.valid !== false,
          position.attributes || {}
        ]
      );
      return rows[0];
    } catch (err) {
      console.error('❌ PositionRepository.save:', err.message);
      throw err;
    }
  }

  /**
   * Última posición conocida de un dispositivo
   */
  async findLatestByDevice(deviceId) {
    try {
      const { rows } = await query(
        `SELECT * FROM positions WHERE device_id = $1
         ORDER BY fix_time DESC LIMIT 1`,
        [deviceId]
      );
      return rows[0] || null;
    } catch (err) {
      console.error('❌ PositionRepository.findLatestByDevice:', err.message);
      throw err;
    }
  }

  /**
   * Última posición conocida de cada dispositivo — usado para
   * reconstruir el estado de flota al arrancar el backend.
   */
  async findLatestPerDevice() {
    try {
      const { rows } = await query(
        `SELECT DISTINCT ON (device_id) *
         FROM positions
         ORDER BY device_id, fix_time DESC`
      );
      return rows;
    } catch (err) {
      console.error('❌ PositionRepository.findLatestPerDevice:', err.message);
      throw err;
    }
  }

  /**
   * Historial de posiciones para reportes / replay (RF panel admin)
   */
  async findHistory({ deviceId, from, to, limit = 5000 }) {
    try {
      const { rows } = await query(
        `SELECT * FROM positions
         WHERE device_id = $1 AND fix_time BETWEEN $2 AND $3
         ORDER BY fix_time ASC
         LIMIT $4`,
        [deviceId, from, to, limit]
      );
      return rows;
    } catch (err) {
      console.error('❌ PositionRepository.findHistory:', err.message);
      throw err;
    }
  }
}

module.exports = PositionRepository;
