/**
 * UserRepository.js
 *
 * Responsabilidad: CRUD de usuarios (operadores, supervisores,
 * admins) en PostgreSQL. Las contraseñas se guardan hasheadas
 * con bcrypt — el hasheo ocurre en auth.routes.js / devices UI,
 * este repositorio solo persiste el valor recibido.
 */

const { query } = require('../config/database');

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

  async delete(id) {
    try {
      await query('DELETE FROM users WHERE id = $1', [id]);
      return true;
    } catch (err) {
      console.error('❌ UserRepository.delete:', err.message);
      throw err;
    }
  }
}

module.exports = UserRepository;
