/**
 * database.js
 *
 * Responsabilidad: Exponer un pool de conexiones a PostgreSQL
 * (con PostGIS + TimescaleDB) y utilidades básicas de consulta.
 *
 * Reemplaza la base de datos de Traccar — toda la persistencia
 * de dispositivos, posiciones, geocercas y usuarios vive aquí.
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'gaga_gps',
  user: process.env.DB_USER || 'gaga_app',
  password: process.env.DB_PASSWORD || 'gaga_dev_pass',
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('connect', () => {
  console.log('✅ PostgreSQL — nueva conexión establecida');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL — error inesperado en cliente inactivo:', err.message);
});

/**
 * Ejecuta una consulta usando el pool compartido
 * @param {string} text - SQL con placeholders $1, $2...
 * @param {Array} params
 */
async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    console.error(`❌ Error en query PostgreSQL: ${err.message}`);
    throw err;
  }
}

/**
 * Verifica conectividad — usado por el health check
 */
async function checkConnection() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    console.error('❌ PostgreSQL no disponible:', err.message);
    return false;
  }
}

module.exports = { pool, query, checkConnection };
