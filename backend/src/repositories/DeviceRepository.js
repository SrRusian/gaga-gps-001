/**
 * DeviceRepository.js
 *
 * Responsabilidad: CRUD de dispositivos (tabletas) en PostgreSQL.
 * Reemplaza la gestión de dispositivos del panel de Traccar.
 */

const { pool, query } = require('../config/database');

/**
 * Error específico para cuando se intenta eliminar un dispositivo
 * que aún tiene posiciones y/o turnos de operador asociados —
 * permite a la capa de rutas responder 409 con un mensaje claro en
 * lugar de un 500 genérico.
 */
class DeviceHasPositionsError extends Error {
  constructor(uniqueId) {
    super(`El dispositivo ${uniqueId} tiene posiciones y/o turnos de operador registrados — no se puede eliminar sin forzar`);
    this.code = 'DEVICE_HAS_POSITIONS';
  }
}

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

  /**
   * Elimina un dispositivo. Por defecto, si tiene posiciones y/o
   * turnos de operador registrados (casos comunes — la telemetría
   * persiste desde el primer reporte) se rechaza con
   * DeviceHasPositionsError para preservar el historial de
   * auditoría/seguridad.
   *
   * @param {boolean} force - si es true, purga también el historial
   *   de posiciones y turnos de operador del dispositivo antes de
   *   eliminarlo (acción destructiva explícita, no es el
   *   comportamiento por defecto).
   */
  async delete(id, { force = false } = {}) {
    const client = force ? await pool.connect() : null;
    try {
      if (force) {
        await client.query('BEGIN');
        await client.query('DELETE FROM operator_sessions WHERE device_id = (SELECT unique_id FROM devices WHERE id = $1)', [id]);
        await client.query('DELETE FROM positions WHERE device_id = (SELECT unique_id FROM devices WHERE id = $1)', [id]);
        await client.query('DELETE FROM devices WHERE id = $1', [id]);
        await client.query('COMMIT');
      } else {
        await query('DELETE FROM devices WHERE id = $1', [id]);
      }
      return true;
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});

      // 23503 = foreign_key_violation en PostgreSQL
      if (err.code === '23503') {
        const device = await this.findById(id);
        throw new DeviceHasPositionsError(device ? device.unique_id : id);
      }

      console.error('❌ DeviceRepository.delete:', err.message);
      throw err;
    } finally {
      if (client) client.release();
    }
  }
}

module.exports = DeviceRepository;
module.exports.DeviceHasPositionsError = DeviceHasPositionsError;
