import type { ClientToServerEvents, ServerToClientEvents } from '@gaga-gps/shared-types';
import { io, type Socket } from 'socket.io-client';
import { getApiBaseUrl } from './deviceConfig';
import { clearSession, getStoredToken, goToLogin } from './session';

export type GagaSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function createSocket(url?: string): GagaSocket {
  const socket: GagaSocket = io(url ?? (getApiBaseUrl() || window.location.origin), {
    // polling primero (orden default de socket.io), luego upgrade a websocket - forzar websocket
    // desde el primer intento hace que, bajo StrictMode (dev), el socket que React descarta en el
    // doble-montaje alcance a abrir un WebSocket real antes del cleanup, y el navegador reporta
    // "WebSocket is closed before the connection is established" (inofensivo, solo en dev, pero
    // evitable). Con polling primero ese intento descartado es una petición HTTP normal.
    transports: ['polling', 'websocket'],
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
