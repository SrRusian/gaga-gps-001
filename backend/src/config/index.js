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
  mapsDir: process.env.MAPS_DIR || 'maps'
};

module.exports = {
  env,
  db: database,
  redis: redisConfig
};
