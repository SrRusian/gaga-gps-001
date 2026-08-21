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
  projectId: number | null;
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
    throw new AuthTokenError('Los permisos del usuario cambiaron - vuelva a iniciar sesión');
  }
  if (user.project_id !== payload.projectId) {
    throw new AuthTokenError('Los permisos del usuario cambiaron - vuelva a iniciar sesión');
  }

  return payload;
}

export async function tryVerifyUser(
  token: string | null,
  userRepo: UserRepository,
): Promise<AuthTokenPayload | null> {
  try {
    return await verifyToken(token, userRepo);
  } catch {
    return null;
  }
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

export function buildDownloadAuthMiddleware({
  userRepo,
}: {
  userRepo: UserRepository;
}): RequestHandler {
  return async function downloadAuthMiddleware(req: Request, res: Response, next: NextFunction) {
    const header = req.headers.authorization || '';
    const headerToken = header.startsWith('Bearer ') ? header.slice(7) : null;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : null;

    try {
      req.user = await verifyToken(headerToken || queryToken, userRepo);
      next();
    } catch (err) {
      res.status(401).json({ error: (err as Error).message });
    }
  };
}

export function projectRoom(projectId: number): string {
  return `project:${projectId}`;
}

export const ADMIN_ROOM = 'role:admin';
export function buildSocketAuthMiddleware({ userRepo }: { userRepo: UserRepository }) {
  return async function socketAuthMiddleware(
    socket: Socket,
    next: (err?: Error) => void,
  ): Promise<void> {
    const token = (socket.handshake.auth?.token as string | undefined) ?? null;
    try {
      const user = await verifyToken(token, userRepo);
      (socket.data as { user?: AuthTokenPayload }).user = user;

      if (user.role === 'admin') {
        socket.join(ADMIN_ROOM);
      } else if (user.projectId !== null) {
        socket.join(projectRoom(user.projectId));
      }

      next();
    } catch (err) {
      // .data marca el error como falla de autenticación (no de red) para que el cliente
      // no reintente indefinidamente - ver createSocket() en packages/client/src/socket.ts
      const socketError = new Error((err as Error).message) as Error & { data?: { code: string } };
      socketError.data = { code: 'AUTH_FAILED' };
      next(socketError);
    }
  };
}

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'No autorizado para esta acción' });
    }
    next();
  };
}
