/**
 * logger.ts
 *
 * Responsabilidad: Configurar Winston como logger central
 * del backend (consola + archivo), complementando los
 * console.log con emojis usados en los servicios.
 */
import type { NextFunction, Request, Response } from 'express';
import winston from 'winston';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `${timestamp} [${String(level).toUpperCase()}] ${message}`,
    ),
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

/**
 * Middleware Express - registra cada request entrante
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  logger.info(`${req.method} ${req.originalUrl} - IP: ${req.ip}`);
  next();
}
