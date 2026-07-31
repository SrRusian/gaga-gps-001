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
  // Tamaño máximo (MB) de cada archivo al importar un mapa
  // satelital/drone (TIF/JPG o TFW/JPW) — ver maps-admin.routes.js.
  maxMapUploadMb: parseInt(process.env.MAX_MAP_UPLOAD_MB || '500', 10),
  // Clave compartida opcional para /gps — ver telemetry.routes.js.
  // Null = endpoint abierto (solo protegido por rate limit), útil
  // en desarrollo; en producción es obligatoria (ver validateEnv).
  telemetrySharedSecret: process.env.TELEMETRY_SHARED_SECRET || null,

  // Filtro anti-teletransporte (glitch RTK/NTRIP) — ver
  // PositionFilterService.js. Umbral adaptativo por dispositivo,
  // no un límite fijo de tipo de vehículo. Todos tienen default
  // razonable — no requiere configuración para funcionar.
  positionFilter: {
    // Margen sobre la velocidad reciente del dispositivo antes de
    // considerar un salto como sospechoso.
    toleranceFactor: parseFloat(process.env.POSITION_FILTER_TOLERANCE_FACTOR || '1.8'),
    // Piso mínimo (km/h) — headroom para arrancar desde parado.
    minFloorKmh: parseFloat(process.env.POSITION_FILTER_MIN_FLOOR_KMH || '25'),
    // Techo de seguridad (km/h) — ni el vehículo más rápido del
    // sitio debería superarlo nunca.
    absoluteCeilingKmh: parseFloat(process.env.POSITION_FILTER_ABSOLUTE_CEILING_KMH || '120'),
    // Radio (metros) de ruido GPS normal con el vehículo detenido.
    jitterRadiusMeters: parseFloat(process.env.POSITION_FILTER_JITTER_RADIUS_M || '5'),
    // Cuántas velocidades recientes se recuerdan por dispositivo.
    historyWindow: parseInt(process.env.POSITION_FILTER_HISTORY_WINDOW || '8', 10),
    // Rechazos consecutivos antes de resincronizar (fail-open) —
    // evita que un vehículo se quede "congelado" en el mapa.
    maxConsecutiveRejects: parseInt(process.env.POSITION_FILTER_MAX_CONSECUTIVE_REJECTS || '3', 10)
  }
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

