import type { ClientToServerEvents, ServerToClientEvents } from '@gaga-gps/shared-types';
import { io, type Socket } from 'socket.io-client';
import { clearSession, getStoredToken, goToLogin } from './session';

export type GagaSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function createSocket(url?: string): GagaSocket {
  const socket: GagaSocket = io(url ?? window.location.origin, {
    transports: ['websocket', 'polling'],
    auth: { token: getStoredToken() },
  });

  socket.on('connect_error', (err: Error & { data?: { code?: string } }) => {
    if (err.data?.code === 'AUTH_FAILED') {
      socket.disconnect();
      clearSession();
      goToLogin();
    }
  });

  return socket;
}
