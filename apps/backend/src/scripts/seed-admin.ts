/**
 * seed-admin.ts
 *
 * Script de utilidad para crear el primer usuario admin del
 * panel /admin. Uso:
 *
 *   node dist/scripts/seed-admin.js <email> <password> [nombre]
 *
 * Ejemplo:
 *   node dist/scripts/seed-admin.js admin@gaga.com MiPassword123 "Admin GAGA"
 *
 * Requiere que PostgreSQL esté accesible con las variables de
 * entorno del .env de la raíz del repo (DB_HOST, DB_PORT, DB_NAME,
 * DB_USER, DB_PASSWORD).
 */
import '../config/loadEnv';
import bcrypt from 'bcryptjs';
import { pool } from '../config/database';

async function main() {
  const [, , email, password, name] = process.argv;

  if (!email || !password) {
    console.error('Uso: node dist/scripts/seed-admin.js <email> <password> [nombre]');
    process.exit(1);
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    const { rows } = await pool.query(
      `INSERT INTO users (email, password, name, role)
       VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (email) DO UPDATE SET password = EXCLUDED.password, role = 'admin'
       RETURNING id, email, name, role`,
      [email, passwordHash, name || 'Administrador'],
    );

    console.log('Usuario admin creado/actualizado:', rows[0]);
  } catch (err) {
    console.error('Error creando usuario admin:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
