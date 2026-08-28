import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

export const telemetryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const id = req.query.id || (req.body as { id?: string } | undefined)?.id;
    return id ? `device:${id}` : ipKeyGenerator(req.ip as string);
  },
  message: 'Demasiadas solicitudes de telemetría - intente más tarde',
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Demasiados intentos de inicio de sesión - intente más tarde',
});
