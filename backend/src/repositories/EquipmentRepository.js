/**
 * EquipmentRepository.js
 *
 * Responsabilidad: CRUD de equipo estático (palas, excavadoras,
 * cargadores) en PostgreSQL.
 */

const { query } = require('../config/database');

class EquipmentRepository {

  async findAll() {
    try {
      const { rows } = await query('SELECT * FROM static_equipment ORDER BY id ASC');
      return rows;
    } catch (err) {
      console.error('❌ EquipmentRepository.findAll:', err.message);
      throw err;
    }
  }

  async create({ name, type, latitude, longitude, swingRadius, safetyRadius, status = 'inactive' }) {
    try {
      const { rows } = await query(
        `INSERT INTO static_equipment
           (name, type, latitude, longitude, swing_radius, safety_radius, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [name, type, latitude, longitude, swingRadius, safetyRadius, status]
      );
      return rows[0];
    } catch (err) {
      console.error('❌ EquipmentRepository.create:', err.message);
      throw err;
    }
  }

  async updateStatus(id, status) {
    try {
      const { rows } = await query(
        'UPDATE static_equipment SET status = $2 WHERE id = $1 RETURNING *',
        [id, status]
      );
      return rows[0] || null;
    } catch (err) {
      console.error('❌ EquipmentRepository.updateStatus:', err.message);
      throw err;
    }
  }

  async delete(id) {
    try {
      await query('DELETE FROM static_equipment WHERE id = $1', [id]);
      return true;
    } catch (err) {
      console.error('❌ EquipmentRepository.delete:', err.message);
      throw err;
    }
  }
}

module.exports = EquipmentRepository;
