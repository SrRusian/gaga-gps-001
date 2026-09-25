import type { Geofence } from '@gaga-gps/shared-types';

// Persistencia local del Operador para operar sin conexion: la configuracion que normalmente llega
// por socket se guarda para que la app funcione igual tras reabrirse sin red, y los eventos de
// geocerca generados sin conexion se encolan hasta poder mandarlos al servidor.
//
// localStorage y no IndexedDB a proposito: el volumen real es chico (decenas de geocercas, y una
// alerta solo se encola en una transicion real, no por tick) y toda la app ya usa localStorage
// para su configuracion. Toda lectura/escritura va en try/catch - en un WebView con el
// almacenamiento bloqueado o lleno, la app debe seguir funcionando, solo sin memoria entre sesiones.

const GEOFENCES_KEY = 'gaga_offline_geofences';
// separado del array de geocercas a proposito: un array vacio no distingue "nunca llego
// geofences:update" de "llego y de verdad el proyecto no tiene ninguna" - ver isInsideAllowedZone
// en useLocalAlerts.ts, que necesita saber cual de los dos casos es de verdad
const GEOFENCES_READY_KEY = 'gaga_offline_geofences_ready';
const ALERT_QUEUE_KEY = 'gaga_offline_alert_queue';
const RESTRICTED_ZONE_KEY = 'gaga_restricted_to_allowed_zone';

// tope de seguridad, no de operacion normal: una alerta se encola por transicion (entrar/salir de
// una zona), no por segundo, asi que ni un turno entero sin red deberia acercarse. Si se desborda
// se descartan las MAS VIEJAS, mismo criterio que el buffer de posiciones: lo reciente vale mas.
const MAX_QUEUED_ALERTS = 2000;

export interface QueuedGeofenceAlert {
  deviceId: string;
  geofenceId: number;
  geofenceName: string;
  severity: 'warning' | 'danger' | 'info';
  message: string;
  latitude: number;
  longitude: number;
  // ISO - el servidor lo respeta tal cual, es cuando ocurrio de verdad, no cuando se pudo mandar
  occurredAt: string;
  event: 'enter' | 'exit';
}

export function cacheGeofences(geofences: Geofence[]): void {
  try {
    localStorage.setItem(GEOFENCES_KEY, JSON.stringify(geofences));
    localStorage.setItem(GEOFENCES_READY_KEY, 'true');
  } catch {
    // almacenamiento lleno o bloqueado - se sigue operando con lo que ya hay en memoria
  }
}

export function loadCachedGeofences(): Geofence[] {
  try {
    const raw = localStorage.getItem(GEOFENCES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Geofence[]) : [];
  } catch {
    return [];
  }
}

// true = ya llego un geofences:update real al menos una vez (aunque haya sido con 0 geocercas) -
// distingue "nunca cargo" (no confiar todavia, ver zona restringida) de "cargo y de verdad esta
// vacio" (confiar, un proyecto sin ninguna geocerca 'allowed' es un caso valido)
export function loadGeofencesReady(): boolean {
  try {
    return localStorage.getItem(GEOFENCES_READY_KEY) === 'true';
  } catch {
    return false;
  }
}

// "el servidor le dice al dispositivo la regla, no al reves" - se cachea igual que las geocercas,
// asi la tableta sabe si debe permanecer en zona permitida aunque arranque sin conexion. Se
// actualiza via el evento de socket device:config (ver useOperatorSocket.ts), que llega al conectar
// y en cuanto un admin cambia el valor - nunca se le pregunta al servidor, el servidor avisa.
export function cacheRestrictedToAllowedZone(value: boolean): void {
  try {
    localStorage.setItem(RESTRICTED_ZONE_KEY, JSON.stringify(value));
  } catch {
    // ver comentario de cacheGeofences
  }
}

export function loadCachedRestrictedToAllowedZone(): boolean {
  try {
    return localStorage.getItem(RESTRICTED_ZONE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function queueOfflineAlert(alert: QueuedGeofenceAlert): void {
  try {
    const queue = loadQueuedAlerts();
    queue.push(alert);
    const trimmed = queue.length > MAX_QUEUED_ALERTS ? queue.slice(queue.length - MAX_QUEUED_ALERTS) : queue;
    localStorage.setItem(ALERT_QUEUE_KEY, JSON.stringify(trimmed));
  } catch {
    // ver comentario de cacheGeofences
  }
}

export function loadQueuedAlerts(): QueuedGeofenceAlert[] {
  try {
    const raw = localStorage.getItem(ALERT_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedGeofenceAlert[]) : [];
  } catch {
    return [];
  }
}

// se borran solo las que de verdad se confirmaron enviadas, por si llegaron alertas nuevas
// mientras la peticion estaba en vuelo
export function dropSentAlerts(sentCount: number): void {
  try {
    const remaining = loadQueuedAlerts().slice(sentCount);
    localStorage.setItem(ALERT_QUEUE_KEY, JSON.stringify(remaining));
  } catch {
    // ver comentario de cacheGeofences
  }
}
