import { createApiClient, getStoredToken } from '@gaga-gps/client';

// Canal de la tableta hacia el servidor para los eventos que ella misma decide (exceso de
// velocidad, entrada/salida de zona). Con red se manda al instante; sin red se encola y se drena
// al reconectar, sin limite de cuantas tandas - lo generado sin conexion tiene que quedar
// registrado si o si (pedido explicito).
//
// localStorage y no IndexedDB: un evento se encola por TRANSICION (entrar/salir de una zona,
// cruzar el limite), no por tick, asi que ni un turno entero sin red se acerca al tope.

const api = createApiClient({ getToken: getStoredToken });

const QUEUE_KEY = 'gaga_device_event_queue';
const BATCH_SIZE = 500; // debe coincidir con MAX_DEVICE_EVENTS del backend
const MAX_QUEUED = 5000;

export interface DeviceEvent {
  // 'zone_status' es un aviso puro de "estoy en zona permitida/estacionamiento" - no genera alerta
  // ni infraccion, solo actualiza el estado que SignalLostService usa (ver useLocalAlerts.ts).
  // 'restricted_zone' es la violacion real (dispositivo restringido, fuera de "allowed") - SI
  // genera alerta/infraccion, mismo criterio que danger de geocerca.
  kind: 'geofence' | 'speed' | 'zone_status' | 'restricted_zone';
  state: 'raised' | 'cleared';
  deviceId: string;
  severity: 'warning' | 'danger' | 'info';
  message: string;
  latitude: number;
  longitude: number;
  occurredAt: string;
  geofenceId?: number | null;
  geofenceName?: string | null;
  speedKmh?: number | null;
  limitKmh?: number | null;
  // ultima zona permitida/estacionamiento conocida - el servidor lo recuerda para no alarmar al
  // proyecto si la tableta se desconecta estando estacionada donde puede estarlo
  inAllowedZone?: boolean;
}

function loadQueue(): DeviceEvent[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DeviceEvent[]) : [];
  } catch {
    return [];
  }
}

function saveQueue(queue: DeviceEvent[]): void {
  try {
    const trimmed = queue.length > MAX_QUEUED ? queue.slice(queue.length - MAX_QUEUED) : queue;
    localStorage.setItem(QUEUE_KEY, JSON.stringify(trimmed));
  } catch {
    // almacenamiento lleno o bloqueado - se sigue operando, solo sin memoria entre sesiones
  }
}

function enqueue(event: DeviceEvent): void {
  saveQueue([...loadQueue(), event]);
}

// Se intenta mandar de inmediato SIEMPRE que haya algo encolado, para no reordenar: si hay cola
// pendiente, este evento va al final y se drena junto con lo demas. Asi el servidor reconstruye
// los eventos en el orden real en que ocurrieron.
export async function reportDeviceEvent(event: DeviceEvent): Promise<void> {
  enqueue(event);
  await flushDeviceEvents();
}

let flushing = false;

export async function flushDeviceEvents(): Promise<void> {
  if (flushing) return; // un solo drenado a la vez, si no se mandarian duplicados
  flushing = true;
  try {
    while (true) {
      const queue = loadQueue();
      if (queue.length === 0) return;
      const batch = queue.slice(0, BATCH_SIZE);
      await api.post('/api/alerts/device-events', { events: batch });
      saveQueue(loadQueue().slice(batch.length));
    }
  } catch {
    // sin red o servidor caido: queda encolado y se reintenta en el proximo evento o reconexion
  } finally {
    flushing = false;
  }
}

export function queuedDeviceEventCount(): number {
  return loadQueue().length;
}
