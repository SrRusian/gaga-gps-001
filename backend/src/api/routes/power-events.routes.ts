import express from 'express';
import { env } from '../../config';
import type AlertEventRepository from '../../repositories/AlertEventRepository';
import type DeviceRepository from '../../repositories/DeviceRepository';
import type GeofenceRepository from '../../repositories/GeofenceRepository';
import { isValidSharedSecret } from '../../utils/sharedSecret';

interface SocketServerLike {
  broadcastToProject(projectId: number | null, event: string, payload: unknown): void;
}

interface SignalLostServiceLike {
  suspendDevice(deviceId: string): void;
  resumeDevice(deviceId: string): void;
}

export interface PowerEventsRouterDeps {
  deviceRepo: DeviceRepository;
  geofenceRepo: GeofenceRepository;
  alertEventRepo?: AlertEventRepository;
  signalLostService?: SignalLostServiceLike;
  socketServer?: SocketServerLike;
}

// Tableta -> backend, clave compartida (sin sesion, mismo criterio que /gps - el origen real es
// el propio dispositivo, no un navegador). Ver power/PowerSuspendAlarmReceiver.kt: la tableta
// manda /power-lost tras 1 min sin corriente (antes de entrar en suspension profunda) y
// /power-restored al recuperar el cable. El backend decide si la posicion cae dentro de una
// geocerca tipo "estacionamiento" (type=parking, ya existente - no se creo un tipo nuevo) para
// silenciar sin_senal mientras dure - fuera de una zona asi, se dispara una alerta real de
// inmediato (vehiculo perdio energia donde no deberia).
export function buildPowerEventsRouter({
  deviceRepo,
  geofenceRepo,
  alertEventRepo,
  signalLostService,
  socketServer,
}: PowerEventsRouterDeps) {
  const router = express.Router();

  function validKey(key: unknown): boolean {
    return !env.telemetrySharedSecret || isValidSharedSecret(env.telemetrySharedSecret, key);
  }

  router.post('/power-lost', async (req, res) => {
    try {
      const { deviceId, lat, lon, key } = req.body;
      if (!validKey(key)) return res.status(401).json({ error: 'Clave inválida' });
      if (!deviceId || lat === undefined || lon === undefined) {
        return res.status(400).json({ error: 'deviceId, lat y lon son requeridos' });
      }

      const latitude = Number(lat);
      const longitude = Number(lon);
      if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
        return res.status(400).json({ error: 'lat/lon inválidos' });
      }

      const device = await deviceRepo.findByUniqueId(String(deviceId));
      const projectId = device?.project_id ?? null;

      const matches = await geofenceRepo.findMatchingSpatial({ projectId, latitude, longitude });
      const authorized = matches.some((m) => m.type === 'parking');

      await deviceRepo.mergeAttributes(String(deviceId), {
        powerSuspended: true,
        powerSuspendedAuthorized: authorized,
        powerSuspendedAt: new Date().toISOString(),
      });

      if (authorized) {
        signalLostService?.suspendDevice(String(deviceId));
        await alertEventRepo?.resolveOpen({ alertType: 'power_loss', deviceId: String(deviceId) });
      } else {
        const message = `PRECAUCIÓN - VEHÍCULO ${deviceId} PERDIÓ CORRIENTE FUERA DE ZONA AUTORIZADA`;
        const payload = {
          type: 'power_loss',
          deviceId: String(deviceId),
          message,
          loop: false,
          timestamp: new Date().toISOString(),
        };
        socketServer?.broadcastToProject(projectId, 'alert:critical', payload);
        socketServer?.broadcastToProject(projectId, 'supervisor:alert', { ...payload, action: 'entered' });
        await alertEventRepo?.recordOrEscalate({
          alertType: 'power_loss',
          severity: 'danger',
          deviceId: String(deviceId),
          message,
          metadata: { latitude, longitude },
        });
      }

      res.json({ success: true, authorized });
    } catch (err) {
      console.error('power-events.routes POST /power-lost:', (err as Error).message);
      res.status(500).json({ error: 'Error procesando evento de energía' });
    }
  });

  // corriente restaurada - limpia el estado de suspension y reactiva sin_senal normal. Es la
  // unica forma de salir de la suspension (con Modo Kiosko activado no hay reactivacion por
  // tocar la pantalla - pedido explicito, ver TraccarSenderService.kt)
  router.post('/power-restored', async (req, res) => {
    try {
      const { deviceId, key } = req.body;
      if (!validKey(key)) return res.status(401).json({ error: 'Clave inválida' });
      if (!deviceId) return res.status(400).json({ error: 'deviceId es requerido' });

      await deviceRepo.mergeAttributes(String(deviceId), {
        powerSuspended: false,
        powerSuspendedAuthorized: false,
      });
      signalLostService?.resumeDevice(String(deviceId));
      await alertEventRepo?.resolveOpen({ alertType: 'power_loss', deviceId: String(deviceId) });

      res.json({ success: true });
    } catch (err) {
      console.error('power-events.routes POST /power-restored:', (err as Error).message);
      res.status(500).json({ error: 'Error procesando evento de energía' });
    }
  });

  return router;
}

export default buildPowerEventsRouter;
