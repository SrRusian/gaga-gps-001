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
  // Token de la UI de operador (tableta fija en el vehículo) — vive
  // mucho más que el del panel admin porque no queremos forzar
  // re-login constante en un turno de varios días; la expiración
  // real por inactividad la maneja operatorSessionMaxIdleDays
  // (ver OperatorSessionRepository.closeStaleSessions).
  operatorJwtExpiresIn: process.env.OPERATOR_JWT_EXPIRES_IN || '30d',
  operatorSessionMaxIdleDays: parseInt(process.env.OPERATOR_SESSION_MAX_IDLE_DAYS || '7', 10),
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

