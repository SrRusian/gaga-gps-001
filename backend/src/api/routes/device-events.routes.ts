import express from 'express';
import type AlertEventRepository from '../../repositories/AlertEventRepository';
import type InfractionRepository from '../../repositories/InfractionRepository';

// Ingesta de lo que la TABLETA decidio por su cuenta (exceso de velocidad, entrada/salida de zona).
// Desde el rediseño de "la tableta evalua, el servidor registra", el Operador es la fuente de
// verdad: aqui no se vuelve a evaluar nada, solo se registra, se levanta la infraccion y se le
// cuenta al resto del proyecto. Ver app/packages/operator-ui/src/useLocalAlerts.ts.
//
// Acepta tanto un evento en vivo como una tanda drenada del buffer sin conexion - son el mismo
// camino a proposito, para que un evento generado sin red termine exactamente igual de registrado.

const MAX_DEVICE_EVENTS = 500;
const VALID_SEVERITIES = new Set(['info', 'warning', 'danger']);

// gravedad de la infraccion por exceso: misma escala que utils/infractionSeverity.ts del backend
function speedInfractionSeverity(speedKmh: number, limitKmh: number): number {
  const over = (speedKmh - limitKmh) / limitKmh;
  if (over <= 0) return 4;
  return Math.max(4, Math.min(10, Math.round(4 + over * 12)));
}

interface SocketServerLike {
  sendToDevice(deviceId: string, event: string, payload: unknown): void;
  broadcastToProject(projectId: number | null, event: string, payload: unknown): void;
  broadcastToProjectExceptDevice(
    projectId: number | null,
    excludeDeviceId: string,
    event: string,
    payload: unknown,
  ): void;
}

interface GeofenceEventRepoLike {
  record(input: {
    deviceId: string;
    geofenceId: number | null;
    eventType: 'enter' | 'exit';
    severity?: string | null;
  }): Promise<unknown>;
}

interface SignalLostServiceLike {
  setZoneExempt(deviceId: string, exempt: boolean): void;
}

interface DeviceRepoLike {
  findByUniqueId(uniqueId: string): Promise<{ project_id: number | null } | null>;
}

export interface DeviceEventsRouterDeps {
  alertEventRepo: AlertEventRepository;
  infractionRepo: InfractionRepository;
  geofenceEventRepo: GeofenceEventRepoLike;
  deviceRepo: DeviceRepoLike;
  socketServer: SocketServerLike | null;
  signalLostService?: SignalLostServiceLike;
}

export function buildDeviceEventsRouter({
  alertEventRepo,
  infractionRepo,
  geofenceEventRepo,
  deviceRepo,
  socketServer,
  signalLostService,
}: DeviceEventsRouterDeps) {
  const router = express.Router();

  router.post('/device-events', async (req, res) => {
    try {
      const events = req.body?.events;
      if (!Array.isArray(events) || events.length === 0) {
        return res.status(400).json({ error: 'Se espera { events: [...] } con al menos un elemento' });
      }
      if (events.length > MAX_DEVICE_EVENTS) {
        return res.status(400).json({ error: `Máximo ${MAX_DEVICE_EVENTS} eventos por lote` });
      }

      let stored = 0;
      for (const event of events) {
        if (await handleEvent(event)) stored += 1;
      }
      res.json({ success: true, stored });
    } catch (err) {
      console.error('device-events.routes POST:', (err as Error).message);
      res.status(500).json({ error: 'Error registrando eventos del dispositivo' });
    }
  });

  async function handleEvent(event: Record<string, unknown>): Promise<boolean> {
    const deviceId = event?.deviceId ? String(event.deviceId) : null;
    const severity = String(event?.severity) as 'info' | 'warning' | 'danger';
    const kind = String(event?.kind);
    const state = String(event?.state);
    const occurredAt = new Date(String(event?.occurredAt));

    if (!deviceId || !VALID_SEVERITIES.has(severity)) return false;
    if (kind !== 'geofence' && kind !== 'speed') return false;
    if (Number.isNaN(occurredAt.getTime())) return false;

    // lo ultimo que la tableta reporto sobre si estaba estacionada donde puede estarlo - se usa
    // para no alarmar al proyecto si justo despues se queda sin señal (ver SignalLostService)
    if (typeof event.inAllowedZone === 'boolean') {
      signalLostService?.setZoneExempt(deviceId, event.inAllowedZone);
    }

    const device = await deviceRepo.findByUniqueId(deviceId);
    const projectId = device?.project_id ?? null;
    const alertType = kind === 'speed' ? 'speed' : 'geofence';
    const message = event?.message ? String(event.message) : null;

    if (state === 'cleared') {
      await alertEventRepo.resolveOpen({ alertType, deviceId });
      socketServer?.broadcastToProjectExceptDevice(projectId, deviceId, 'alert:clear', {
        deviceId,
        timestamp: new Date().toISOString(),
      });
      if (kind === 'geofence' && typeof event.geofenceId === 'number') {
        await geofenceEventRepo.record({
          deviceId,
          geofenceId: event.geofenceId,
          eventType: 'exit',
          severity,
        });
      }
      return true;
    }

    await alertEventRepo.recordOrEscalate({
      alertType,
      severity: severity === 'info' ? 'info' : severity,
      deviceId,
      message,
      metadata: { reportedByDevice: true, ...pickMetadata(event) },
      projectId,
    });

    if (kind === 'geofence' && typeof event.geofenceId === 'number') {
      await geofenceEventRepo.record({
        deviceId,
        geofenceId: event.geofenceId,
        eventType: 'enter',
        severity,
      });
    }

    // solo lo grave deja infraccion permanente - un aviso que el operador corrigio a tiempo no
    // tiene por que quedarle en el expediente
    if (severity === 'danger') {
      const speedKmh = toNumber(event.speedKmh);
      const limitKmh = toNumber(event.limitKmh);
      await infractionRepo.create({
        projectId,
        deviceId,
        infractionType: kind === 'speed' ? 'speed' : 'geofence',
        message: message ?? 'Infracción reportada por el dispositivo',
        latitude: toNumber(event.latitude) ?? 0,
        longitude: toNumber(event.longitude) ?? 0,
        severity:
          kind === 'speed' && speedKmh !== null && limitKmh !== null
            ? speedInfractionSeverity(speedKmh, limitKmh)
            : 8,
        occurredAt,
        metadata: { reportedByDevice: true, ...pickMetadata(event) },
      });
    }

    // NUNCA se le devuelve la alerta a la tableta que la reporto: ella ya la esta mostrando y
    // sonando en local desde antes de mandarla. Devolversela creaba un eco que ademas podia dejar
    // el pitido en bucle atorado si el 'cleared' no alcanzaba a llegar (bug real de campo del
    // 19 sep: audio sonando todo el viaje sin ninguna alerta visible).
    const channel = severity === 'danger' ? 'alert:critical' : 'alert:warning';
    socketServer?.broadcastToProjectExceptDevice(projectId, deviceId, channel, {
      deviceId,
      message,
      geofenceId: typeof event.geofenceId === 'number' ? event.geofenceId : null,
      loop: severity === 'danger',
      timestamp: new Date().toISOString(),
    });
    socketServer?.broadcastToProject(projectId, 'supervisor:alert', {
      deviceId,
      type: kind === 'speed' ? 'speed_danger' : 'geofence_red',
      severity,
      message,
      timestamp: new Date().toISOString(),
    });

    return true;
  }

  return router;
}

function toNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickMetadata(event: Record<string, unknown>): Record<string, unknown> {
  return {
    geofenceId: event.geofenceId ?? null,
    geofenceName: event.geofenceName ?? null,
    speedKmh: event.speedKmh ?? null,
    limitKmh: event.limitKmh ?? null,
  };
}

export default buildDeviceEventsRouter;
