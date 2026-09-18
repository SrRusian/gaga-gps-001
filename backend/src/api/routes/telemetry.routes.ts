import express, { type Request, type Response } from 'express';
import { env } from '../../config';
import { isValidSharedSecret } from '../../utils/sharedSecret';
import type PositionProcessor from '../../services/telemetry/PositionProcessor';

export function buildTelemetryRouter({
  positionProcessor,
}: {
  positionProcessor: PositionProcessor;
}) {
  const router = express.Router();

  async function handleGps(req: Request, res: Response) {
    try {
      const params: Record<string, unknown> = { ...req.query, ...req.body };

      if (env.telemetrySharedSecret && !isValidSharedSecret(env.telemetrySharedSecret, params.key)) {
        return res.status(401).send('Clave de telemetría inválida');
      }

      const { id, lat, lon } = params;

      if (!id || lat === undefined || lon === undefined) {
        return res.status(400).send('Faltan parámetros requeridos: id, lat, lon');
      }

      const latitude = parseFloat(String(lat));
      const longitude = parseFloat(String(lon));

      if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
        return res.status(400).send('lat/lon inválidos');
      }

      if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        return res.status(400).send('lat/lon fuera de rango válido');
      }

      const position = buildPosition(params);
      if (!position) return res.status(400).send('Posición inválida');

      await positionProcessor.process(position);

      res.status(200).send('OK');
    } catch (err) {
      console.error('telemetry.routes /gps:', (err as Error).message);
      res.status(500).send('Error procesando posición');
    }
  }

  // Drenado del buffer sin conexion de la tableta. Una peticion por punto convertia un respaldo de
  // una hora (3600 puntos a 1/seg) en 3600 handshakes HTTP sobre una red que acaba de volver; en
  // lote son ~36. Se procesan EN ORDEN, secuencialmente, porque el orden cronologico es justo lo
  // que reconstruye el recorrido - ver PositionFilterService (veredicto backfill).
  async function handleGpsBatch(req: Request, res: Response) {
    try {
      const params: Record<string, unknown> = { ...req.query, ...req.body };

      if (env.telemetrySharedSecret && !isValidSharedSecret(env.telemetrySharedSecret, params.key)) {
        return res.status(401).send('Clave de telemetría inválida');
      }

      const positions = params.positions;
      if (!Array.isArray(positions) || positions.length === 0) {
        return res.status(400).send('Se espera positions: [...] con al menos un elemento');
      }
      if (positions.length > MAX_BATCH_POSITIONS) {
        return res.status(400).send(`Máximo ${MAX_BATCH_POSITIONS} posiciones por lote`);
      }

      let stored = 0;
      for (const raw of positions) {
        const built = buildPosition({ ...(raw as Record<string, unknown>), id: raw?.id ?? params.id });
        if (!built) continue; // un punto corrupto no debe tirar el lote entero
        await positionProcessor.process(built);
        stored += 1;
      }

      res.status(200).json({ success: true, stored });
    } catch (err) {
      console.error('telemetry.routes /gps/batch:', (err as Error).message);
      res.status(500).send('Error procesando lote de posiciones');
    }
  }

  router.get('/gps', handleGps);
  router.post('/gps', handleGps);
  router.post('/gps/batch', handleGpsBatch);

  return router;
}

const KNOTS_TO_MS = 0.514444;
const MAX_BATCH_POSITIONS = 500;

// unica forma de armar una posicion desde parametros OsmAnd - la comparten /gps y /gps/batch para
// que un punto reenviado del buffer se interprete exactamente igual que uno en vivo
function buildPosition(params: Record<string, unknown>) {
  const { id, lat, lon } = params;
  if (!id || lat === undefined || lon === undefined) return null;

  const latitude = parseFloat(String(lat));
  const longitude = parseFloat(String(lon));
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

  // OsmAnd manda speed en NUDOS (asi lo emite TraccarUplink.kt y asi lo decodifica Traccar) - el
  // resto del sistema trabaja en m/s. Sin esta conversion toda velocidad del dispositivo se
  // inflaba x1.94384; medido en datos reales de produccion: razon 1.9153 contra la geometrica
  const speedKnots = parseFloatOrUndefined(params.speed);

  return {
    deviceId: String(id),
    latitude,
    longitude,
    altitude: parseFloatOrDefault(params.altitude, 0),
    // undefined (no 0) si el dispositivo no reporto velocidad - una posicion de antena celular no
    // trae Doppler, y el estimador tiene que poder distinguir "detenido" de "no lo se"
    speed: speedKnots != null ? speedKnots * KNOTS_TO_MS : undefined,
    course: parseFloatOrDefault(params.bearing, 0),
    accuracy: parseFloatOrDefault(params.accuracy, 0),
    battery: params.batt !== undefined ? parseFloatOrDefault(params.batt, null) : null,
    fixTime: parseTimestamp(params.timestamp),
    protocol: 'osmand',
    valid: true,
    attributes: {},
  };
}

function parseFloatOrDefault<T extends number | null>(value: unknown, fallback: T): number | T {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = parseFloat(String(value));
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseFloatOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = parseFloat(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseTimestamp(raw: unknown): Date {
  if (!raw) return new Date();
  const num = Number(raw);
  if (!Number.isNaN(num)) {
    return new Date(num > 1e12 ? num : num * 1000);
  }
  const parsed = new Date(String(raw));
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export default buildTelemetryRouter;
