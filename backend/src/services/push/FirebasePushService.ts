import { cert, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { env } from '../../config';

// envia el push de "actualizar ahora" a las tabletas registradas (POST /api/app/fcm-token, ver
// app-update.routes.ts) - canal aparte del socket que ya usa el panel (FleetSocketServer.
// sendToDevice/broadcast, ver device:force_update), pensado para cuando la tableta no tiene la
// app abierta con sesion de operador iniciada (Login, Ajustes, o app cerrada). No-op gracioso sin
// FIREBASE_SERVICE_ACCOUNT_JSON configurado - misma logica ya usada en este proyecto para
// dependencias opcionales (GDAL, mapas satelitales). API modular de firebase-admin v14+ (el
// namespace clasico admin.credential/admin.app ya no existe en esta version).
let app: App | null | undefined;

function getApp(): App | null {
  if (app !== undefined) return app;
  if (!env.firebaseServiceAccountJson) {
    app = null;
    return app;
  }
  try {
    const serviceAccount = JSON.parse(env.firebaseServiceAccountJson);
    app = initializeApp({ credential: cert(serviceAccount) });
  } catch (err) {
    console.error('FirebasePushService: FIREBASE_SERVICE_ACCOUNT_JSON invalido:', (err as Error).message);
    app = null;
  }
  return app;
}

// fire-and-forget, nunca debe bloquear ni tumbar la ruta que la llama (mismo criterio que el
// resto de notificaciones "informativas" del proyecto, ej. reportInstalledVersion del lado nativo)
export async function sendForceUpdatePush(tokens: string[]): Promise<void> {
  const firebaseApp = getApp();
  const validTokens = tokens.filter((t) => t && t.trim().length > 0);
  if (!firebaseApp || validTokens.length === 0) return;
  try {
    await getMessaging(firebaseApp).sendEachForMulticast({
      tokens: validTokens,
      data: { type: 'force_update' },
      android: { priority: 'high' },
    });
  } catch (err) {
    console.error('FirebasePushService.sendForceUpdatePush:', (err as Error).message);
  }
}
