/**
 * config/index.js
 *
 * Punto único de acceso a la configuración del backend:
 * base de datos, Redis y variables de entorno generales.
 */

require('dotenv').config();

const database = require('./database');
const redisConfig = require('./redis');

const env = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-cambiar-en-produccion',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  mapsDir: process.env.MAPS_DIR || 'maps',
  // Clave compartida opcional para /gps — ver telemetry.routes.js.
  // Null = endpoint abierto (solo protegido por rate limit), útil
  // en desarrollo; en producción es obligatoria (ver validateEnv).
  telemetrySharedSecret: process.env.TELEMETRY_SHARED_SECRET || null
};

/**
 * Valida que la configuración crítica de seguridad esté presente
 * en producción — falla rápido en vez de arrancar con secretos
 * de desarrollo conocidos públicamente o el receptor de
 * telemetría totalmente abierto.
 */
function validateEnv() {
  if (env.nodeEnv !== 'production') return;

  const missing = [];
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  if (!process.env.TELEMETRY_SHARED_SECRET) missing.push('TELEMETRY_SHARED_SECRET');

  if (missing.length > 0) {
    throw new Error(
      `Configuración insegura para producción — faltan variables de entorno: ${missing.join(', ')}`
    );
  }
}

validateEnv();

module.exports = {
  env,
  db: database,
  redis: redisConfig
};

