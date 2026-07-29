/**
 * logger.js
 *
 * Responsabilidad: Configurar Winston como logger central
 * del backend (consola + archivo), complementando los
 * console.log con emojis usados en los servicios.
 */

const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});

/**
 * Middleware Express — registra cada request entrante
 */
function requestLogger(req, res, next) {
  logger.info(`${req.method} ${req.originalUrl} — IP: ${req.ip}`);
  next();
}

module.exports = { logger, requestLogger };
