import type { ClientToServerEvents, ServerToClientEvents } from '@gaga-gps/shared-types';
import { io, type Socket } from 'socket.io-client';
import { getStoredToken } from './session';

export type GagaSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function createSocket(url?: string): GagaSocket {
  return io(url ?? window.location.origin, {
    transports: ['websocket', 'polling'],
    auth: { token: getStoredToken() },
  });
}
