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

      const fixTime = parseTimestamp(params.timestamp);

      const position = {
        deviceId: String(id),
        latitude,
        longitude,
        altitude: parseFloatOrDefault(params.altitude, 0),
        speed: parseFloatOrDefault(params.speed, 0),
        course: parseFloatOrDefault(params.bearing, 0),
        accuracy: parseFloatOrDefault(params.accuracy, 0),
        battery: params.batt !== undefined ? parseFloatOrDefault(params.batt, null) : null,
        fixTime,
        protocol: 'osmand',
        valid: true,
        attributes: {},
      };

      await positionProcessor.process(position);

      res.status(200).send('OK');
    } catch (err) {
      console.error('telemetry.routes /gps:', (err as Error).message);
      res.status(500).send('Error procesando posición');
    }
  }

  router.get('/gps', handleGps);
  router.post('/gps', handleGps);

  return router;
}

function parseFloatOrDefault<T extends number | null>(value: unknown, fallback: T): number | T {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = parseFloat(String(value));
  return Number.isNaN(parsed) ? fallback : parsed;
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
