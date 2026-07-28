/**
 * rateLimiter.js
 *
 * Responsabilidad: Limitar la tasa de peticiones por IP,
 * especialmente en /gps (telemetría) y /api/auth/login
 * para mitigar abuso o dispositivos mal configurados.
 */

const rateLimit = require('express-rate-limit');

// Telemetría — las tabletas reportan cada pocos segundos,
// se permite un margen amplio por dispositivo/IP.
const telemetryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Demasiadas solicitudes de telemetría — intente más tarde'
});

// Login — más restrictivo para dificultar fuerza bruta
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Demasiados intentos de inicio de sesión — intente más tarde'
});

module.exports = { telemetryLimiter, authLimiter };
