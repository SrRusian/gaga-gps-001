/**
 * socket.ts
 *
 * Cliente de Socket.io tipado contra el contrato de
 * @gaga-gps/shared-types — usa los generics propios de
 * socket.io-client en vez de una abstracción de "mapa de eventos"
 * aparte.
 */
import type { ClientToServerEvents, ServerToClientEvents } from '@gaga-gps/shared-types';
import { io, type Socket } from 'socket.io-client';
import { getStoredToken } from './session';

export type GagaSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// El token se lee al conectar (no en cada evento) — como todas las
// UIs pasan por el login único del gateway antes de llegar aquí,
// siempre hay uno vigente en localStorage a esta altura.
export function createSocket(url?: string): GagaSocket {
  return io(url ?? window.location.origin, {
    transports: ['websocket', 'polling'],
    auth: { token: getStoredToken() },
  });
}
