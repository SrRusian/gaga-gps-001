/**
 * auth.middleware.ts
 *
 * Responsabilidad: Verificar el JWT en rutas protegidas (Express) y
 * en la conexión de Socket.io, y adjuntar el usuario decodificado a
 * req.user / socket.data.user.
 *
 * Además de validar firma/expiración, revalida contra PostgreSQL
 * que el usuario siga activo y conserve el rol del token — un JWT
 * emitido antes de desactivar/cambiar de rol a un usuario (válido
 * hasta JWT_EXPIRES_IN, 8h por defecto) no debe seguir autorizando
 * acciones críticas (p. ej. /api/fleet/stop, borrar geocercas) ni
 * seguir recibiendo eventos en tiempo real por socket.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Socket } from 'socket.io';
import { env } from '../../config';
import type UserRepository from '../../repositories/UserRepository';
import type { UserRole } from '../../repositories/UserRepository';

export interface AuthTokenPayload {
  id: number;
  email: string;
  role: UserRole;
  [key: string]: unknown;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthTokenPayload;
    }
  }
}

class AuthTokenError extends Error {}

/**
 * Núcleo compartido por el middleware de Express y el de Socket.io:
 * valida la firma/expiración del JWT y revalida contra PostgreSQL
 * que el usuario siga activo y con el mismo rol.
 */
async function verifyToken(
  token: string | null,
  userRepo: UserRepository,
): Promise<AuthTokenPayload> {
  if (!token) throw new AuthTokenError('Token no proporcionado');

  let payload: AuthTokenPayload;
  try {
    payload = jwt.verify(token, env.jwtSecret) as AuthTokenPayload;
  } catch {
    throw new AuthTokenError('Token inválido o expirado');
  }

  const user = await userRepo.findById(payload.id);
  if (!user || !user.active) {
    throw new AuthTokenError('Usuario inactivo o inexistente');
  }
  if (user.role !== payload.role) {
    // El rol cambió después de emitido el token — se exige
    // reautenticación para reflejar los permisos vigentes.
    throw new AuthTokenError('Los permisos del usuario cambiaron — vuelva a iniciar sesión');
  }

  return payload;
}

export function buildAuthMiddleware({ userRepo }: { userRepo: UserRepository }): RequestHandler {
  return async function authMiddleware(req: Request, res: Response, next: NextFunction) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    try {
      req.user = await verifyToken(token, userRepo);
      next();
    } catch (err) {
      res.status(401).json({ error: (err as Error).message });
    }
  };
}

/**
 * Handshake de Socket.io — todas las UIs necesitan estar logueadas
 * para recibir eventos en tiempo real (antes las conexiones eran
 * completamente abiertas, sin token). Se pasa como `auth: { token }`
 * al conectar (ver packages/client/src/socket.ts). Nadie lee
 * socket.data.user todavía (la conexión en sí es lo que se protege),
 * pero queda disponible ahí para cuando haga falta.
 */
export function buildSocketAuthMiddleware({ userRepo }: { userRepo: UserRepository }) {
  return async function socketAuthMiddleware(
    socket: Socket,
    next: (err?: Error) => void,
  ): Promise<void> {
    const token = (socket.handshake.auth?.token as string | undefined) ?? null;
    try {
      (socket.data as { user?: AuthTokenPayload }).user = await verifyToken(token, userRepo);
      next();
    } catch (err) {
      next(err as Error);
    }
  };
}

/**
 * Middleware de autorización por rol — uso: requireRole('admin')
 */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'No autorizado para esta acción' });
    }
    next();
  };
}
