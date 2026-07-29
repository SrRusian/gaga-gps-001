/**
 * UserRepository.js
 *
 * Responsabilidad: CRUD de usuarios (operadores, supervisores,
 * admins) en PostgreSQL. Las contraseñas se guardan hasheadas
 * con bcrypt — el hasheo ocurre en auth.routes.js / devices UI,
 * este repositorio solo persiste el valor recibido.
 */

const { pool, query } = require('../config/database');

/**
 * Error específico para cuando se intenta eliminar un usuario que
 * tiene turnos de operador (operator_sessions) registrados — igual
 * que con DeviceHasPositionsError, evita perder el historial de
 * horas trabajadas por accidente (útil para auditoría/nómina aunque
 * el usuario ya no esté activo).
 */
class UserHasSessionsError extends Error {
  constructor(email) {
    super(`El usuario ${email} tiene turnos de operador registrados — considere desactivarlo en vez de eliminarlo, o elimine con force=true si de verdad desea perder ese historial`);
    this.code = 'USER_HAS_SESSIONS';
  }
}

class UserRepository {

  async findByEmail(email) {
    try {
      const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
      return rows[0] || null;
    } catch (err) {
      console.error('❌ UserRepository.findByEmail:', err.message);
      throw err;
    }
  }

  async findById(id) {
    try {
      const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
      return rows[0] || null;
    } catch (err) {
      console.error('❌ UserRepository.findById:', err.message);
      throw err;
    }
  }

  async findAll() {
    try {
      const { rows } = await query(
        'SELECT id, email, name, role, active, created_at FROM users ORDER BY name ASC'
      );
      return rows;
    } catch (err) {
      console.error('❌ UserRepository.findAll:', err.message);
      throw err;
    }
  }

  async create({ email, passwordHash, name, role = 'operator' }) {
    try {
      const { rows } = await query(
        `INSERT INTO users (email, password, name, role)
         VALUES ($1,$2,$3,$4)
         RETURNING id, email, name, role, active, created_at`,
        [email, passwordHash, name, role]
      );
      return rows[0];
    } catch (err) {
      console.error('❌ UserRepository.create:', err.message);
      throw err;
    }
  }

  async update(id, { name, role, active }) {
    try {
      const { rows } = await query(
        `UPDATE users SET
           name = COALESCE($2, name),
           role = COALESCE($3, role),
           active = COALESCE($4, active)
         WHERE id = $1
         RETURNING id, email, name, role, active, created_at`,
        [id, name, role, active]
      );
      return rows[0] || null;
    } catch (err) {
      console.error('❌ UserRepository.update:', err.message);
      throw err;
    }
  }

  async updatePassword(id, passwordHash) {
    try {
      await query('UPDATE users SET password = $2 WHERE id = $1', [id, passwordHash]);
    } catch (err) {
      console.error('❌ UserRepository.updatePassword:', err.message);
      throw err;
    }
  }

  /**
   * Elimina un usuario. Por defecto, si tiene turnos de operador
   * registrados (operator_sessions) se rechaza con
   * UserHasSessionsError — se recomienda desactivar en vez de
   * eliminar para conservar el historial de horas trabajadas.
   *
   * @param {boolean} force - si es true, purga también sus turnos
   *   registrados antes de eliminar (acción destructiva explícita).
   */
  async delete(id, { force = false } = {}) {
    const client = force ? await pool.connect() : null;
    try {
      if (force) {
        await client.query('BEGIN');
        await client.query('DELETE FROM operator_sessions WHERE user_id = $1', [id]);
        await client.query('DELETE FROM users WHERE id = $1', [id]);
        await client.query('COMMIT');
      } else {
        await query('DELETE FROM users WHERE id = $1', [id]);
      }
      return true;
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});

      // 23503 = foreign_key_violation en PostgreSQL
      if (err.code === '23503') {
        const user = await this.findById(id);
        throw new UserHasSessionsError(user ? user.email : id);
      }

      console.error('❌ UserRepository.delete:', err.message);
      throw err;
    } finally {
      if (client) client.release();
    }
  }
}

module.exports = UserRepository;
module.exports.UserHasSessionsError = UserHasSessionsError;
