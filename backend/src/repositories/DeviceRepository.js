/**
 * DeviceRepository.js
 *
 * Responsabilidad: CRUD de dispositivos (tabletas) en PostgreSQL.
 * Reemplaza la gestión de dispositivos del panel de Traccar.
 */

const { query } = require('../config/database');

class DeviceRepository {

  /**
   * Busca un dispositivo por su unique_id (id enviado por Traccar Client)
   */
  async findByUniqueId(uniqueId) {
    try {
      const { rows } = await query(
        'SELECT * FROM devices WHERE unique_id = $1',
        [uniqueId]
      );
      return rows[0] || null;
    } catch (err) {
      console.error('❌ DeviceRepository.findByUniqueId:', err.message);
      throw err;
    }
  }

  async findById(id) {
    try {
      const { rows } = await query('SELECT * FROM devices WHERE id = $1', [id]);
      return rows[0] || null;
    } catch (err) {
      console.error('❌ DeviceRepository.findById:', err.message);
      throw err;
    }
  }

  async findAll() {
    try {
      const { rows } = await query('SELECT * FROM devices ORDER BY name ASC');
      return rows;
    } catch (err) {
      console.error('❌ DeviceRepository.findAll:', err.message);
      throw err;
    }
  }

  /**
   * Auto-registra un dispositivo si no existe (RF-TEL — nuevas tabletas
   * no requieren alta manual previa en el panel).
   */
  async findOrCreate(uniqueId, defaults = {}) {
    try {
      const existing = await this.findByUniqueId(uniqueId);
      if (existing) return existing;

      const { rows } = await query(
        `INSERT INTO devices (unique_id, name, type, status)
         VALUES ($1, $2, $3, 'offline')
         ON CONFLICT (unique_id) DO UPDATE SET unique_id = EXCLUDED.unique_id
         RETURNING *`,
        [uniqueId, defaults.name || uniqueId, defaults.type || 'vehicle']
      );
      console.log(`✅ Dispositivo auto-registrado: ${uniqueId}`);
      return rows[0];
    } catch (err) {
      console.error('❌ DeviceRepository.findOrCreate:', err.message);
      throw err;
    }
  }

  async create({ uniqueId, name, type = 'vehicle', attributes = {} }) {
    try {
      const { rows } = await query(
        `INSERT INTO devices (unique_id, name, type, attributes)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [uniqueId, name, type, attributes]
      );
      return rows[0];
    } catch (err) {
      console.error('❌ DeviceRepository.create:', err.message);
      throw err;
    }
  }

  async update(id, { name, type, attributes }) {
    try {
      const { rows } = await query(
        `UPDATE devices SET
           name = COALESCE($2, name),
           type = COALESCE($3, type),
           attributes = COALESCE($4, attributes)
         WHERE id = $1 RETURNING *`,
        [id, name, type, attributes]
      );
      return rows[0] || null;
    } catch (err) {
      console.error('❌ DeviceRepository.update:', err.message);
      throw err;
    }
  }

  async updateStatus(uniqueId, status, lastUpdate = new Date()) {
    try {
      await query(
        'UPDATE devices SET status = $2, last_update = $3 WHERE unique_id = $1',
        [uniqueId, status, lastUpdate]
      );
    } catch (err) {
      console.error('❌ DeviceRepository.updateStatus:', err.message);
      throw err;
    }
  }

  async delete(id) {
    try {
      await query('DELETE FROM devices WHERE id = $1', [id]);
      return true;
    } catch (err) {
      console.error('❌ DeviceRepository.delete:', err.message);
      throw err;
    }
  }
}

module.exports = DeviceRepository;
