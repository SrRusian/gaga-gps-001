/**
 * rateLimiter.ts
 *
 * Responsabilidad: Limitar la tasa de peticiones, especialmente
 * en /gps (telemetría) y /api/auth/login para mitigar abuso o
 * dispositivos mal configurados.
 */
import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

// Telemetría — se limita por dispositivo (query param "id") y no
// solo por IP: en un sitio minero es común que varias tabletas
// compartan una misma IP pública (router LTE/NAT del sitio), así
// que limitar únicamente por IP podría descartar silenciosamente
// posiciones legítimas de varios vehículos. Si no llega "id" (p. ej.
// una request malformada) se usa la IP como respaldo, normalizada
// con ipKeyGenerator para IPv4/IPv6 según exige express-rate-limit v8.
export const telemetryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6000, // ~100/s sostenido — margen amplio para ráfagas de reconexión/backlog
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const id = req.query.id || (req.body as { id?: string } | undefined)?.id; // puede venir en query o en el body (form-urlencoded)
    return id ? `device:${id}` : ipKeyGenerator(req.ip as string);
  },
  message: 'Demasiadas solicitudes de telemetría — intente más tarde',
});

// Login — más restrictivo para dificultar fuerza bruta
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Demasiados intentos de inicio de sesión — intente más tarde',
});
