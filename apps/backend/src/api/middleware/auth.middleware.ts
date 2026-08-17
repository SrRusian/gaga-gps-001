/**
 * auth.middleware.ts
 *
 * Responsabilidad: Verificar el JWT en rutas protegidas (Express) y
 * en la conexión de Socket.io, y adjuntar el usuario decodificado a
 * req.user / socket.data.user.
 *
 * Además de validar firma/expiración, revalida contra PostgreSQL
 * que el usuario siga activo y conserve el rol del token - un JWT
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
  /** null = alcance global (solo admin); cualquier otro rol siempre trae un proyecto. */
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
    // El rol cambió después de emitido el token - se exige
    // reautenticación para reflejar los permisos vigentes.
    throw new AuthTokenError('Los permisos del usuario cambiaron - vuelva a iniciar sesión');
  }
  if (user.project_id !== payload.projectId) {
    // Reasignado a otro proyecto (o a alcance global) - mismo
    // criterio que el cambio de rol: es un límite de aislamiento
    // entre proyectos, no algo que deba esperar a que expire el token.
    throw new AuthTokenError('Los permisos del usuario cambiaron - vuelva a iniciar sesión');
  }

  return payload;
}

/**
 * Variante que nunca rechaza - para endpoints públicos que hoy no
 * exigen login (mismo criterio que `/api/fleet/*`) pero que quieren
 * *aprovechar* el token cuando el llamador sí lo manda (ej. filtrar
 * `/tiles/active-maps.json` por proyecto sin romper el acceso público
 * ya existente para quien no lo mande). `null` = sin token válido,
 * el caller decide el comportamiento por defecto (hoy: sin filtrar).
 */
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

/**
 * Variante para descargas de archivo (exportar geocercas en GeoJSON/
 * KML) - un `<a href>` real (necesario para que el navegador trate la
 * respuesta como una descarga de verdad, no un `blob:` armado a mano
 * con JS, que Chrome bloquea en orígenes sin HTTPS - ver CLAUDE.md)
 * no puede mandar un header `Authorization`, así que este middleware
 * acepta el mismo JWT también por query string (`?token=...`) como
 * alternativa - no es un mecanismo nuevo de autenticación, es el
 * mismo token que ya vive en localStorage, solo con otra forma de
 * transportarlo. Deliberadamente NO reemplaza a `authMiddleware` en
 * el resto de la API - las rutas que crean/editan/eliminan siguen
 * exigiendo el header.
 */
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

/** Sala de un proyecto - ver broadcastToProject en FleetSocketServer. */
export function projectRoom(projectId: number): string {
  return `project:${projectId}`;
}

/** Sala de los admins globales - reciben el tráfico de todos los proyectos. */
export const ADMIN_ROOM = 'role:admin';

/**
 * Handshake de Socket.io - todas las UIs necesitan estar logueadas
 * para recibir eventos en tiempo real (antes las conexiones eran
 * completamente abiertas, sin token). Se pasa como `auth: { token }`
 * al conectar (ver packages/client/src/socket.ts).
 *
 * Además de autenticar, une el socket a su sala de aislamiento por
 * proyecto (o a la sala de admins, que recibe todo) - es lo que le
 * permite a FleetSocketServer.broadcastToProject() nunca alcanzar a
 * un cliente de otro proyecto.
 */
export function buildSocketAuthMiddleware({ userRepo }: { userRepo: UserRepository }) {
  return async function socketAuthMiddleware(
    socket: Socket,
    next: (err?: Error) => void,
  ): Promise<void> {
    const token = (socket.handshake.auth?.token as string | undefined) ?? null;
    try {
      const user = await verifyToken(token, userRepo);
      (socket.data as { user?: AuthTokenPayload }).user = user;

      // Solo el admin global se une a la sala que recibe todo. Un
      // rol de proyecto sin projectId asignado (configuración
      // incompleta) no se cuela ahí "por accidente" - se queda sin
      // sala, o sea sin ver nada, que es el default seguro.
      if (user.role === 'admin') {
        socket.join(ADMIN_ROOM);
      } else if (user.projectId !== null) {
        socket.join(projectRoom(user.projectId));
      }

      next();
    } catch (err) {
      next(err as Error);
    }
  };
}

/**
 * Middleware de autorización por rol - uso: requireRole('admin')
 */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'No autorizado para esta acción' });
    }
    next();
  };
}
