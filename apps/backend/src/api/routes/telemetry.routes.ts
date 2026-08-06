/**
 * telemetry.routes.ts
 *
 * Receptor propio del protocolo OsmAnd, compatible 100% con lo
 * que ya envía Traccar Client desde las tabletas — solo cambia
 * la URL del servidor, no se toca la app de las tabletas.
 *
 * Traccar Client (protocolo OsmAnd) envía estos parámetros, y
 * según la versión/plataforma de la app pueden llegar de tres
 * formas distintas — por eso se combinan query string y body
 * (form-urlencoded o JSON) en un solo objeto de parámetros:
 *   - GET con query string (?id=...&lat=...)
 *   - POST con los mismos parámetros en la URL (query string)
 *   - POST con los parámetros en el body (application/x-www-form-urlencoded)
 *   id         → identificador único del dispositivo (obligatorio)
 *   lat, lon   → coordenadas (obligatorias)
 *   timestamp  → epoch en segundos o ISO (opcional)
 *   altitude   → metros (opcional)
 *   speed      → metros/segundo, Traccar lo reporta así (se
 *                convierte a km/h únicamente en la capa de
 *                presentación — ver reports.routes.js y ui-admin)
 *   bearing    → curso en grados (opcional)
 *   accuracy   → precisión en metros (opcional)
 *   batt       → nivel de batería % (opcional)
 *   key        → clave compartida (RF de seguridad, ver env.telemetrySharedSecret).
 *                Traccar Client permite fijar la "Server URL" con un query
 *                string propio (p. ej. https://host/gps?key=SECRETO) — el
 *                cliente simplemente añade sus parámetros a continuación,
 *                sin sobreescribirlo (aplica solo cuando usa query string).
 *
 * RF asociados: RF-TEL-01, RF-TEL-02
 */
import nodeCrypto from 'crypto';
import express, { type Request, type Response } from 'express';
import { env } from '../../config';
import type PositionProcessor from '../../services/telemetry/PositionProcessor';

export function buildTelemetryRouter({
  positionProcessor,
}: {
  positionProcessor: PositionProcessor;
}) {
  const router = express.Router();

  async function handleGps(req: Request, res: Response) {
    try {
      // Combina query string y body — distintas versiones de
      // Traccar Client envían los parámetros en uno u otro.
      const params: Record<string, unknown> = { ...req.query, ...req.body };

      // Clave compartida — mitiga spoofing/inyección de posiciones
      // falsas por terceros que alcancen este endpoint público.
      if (env.telemetrySharedSecret && !isValidSharedSecret(params.key)) {
        return res.status(401).send('Clave de telemetría inválida');
      }

      const { id, lat, lon } = params;

      // Validación de parámetros obligatorios del protocolo OsmAnd
      if (!id || lat === undefined || lon === undefined) {
        return res.status(400).send('Faltan parámetros requeridos: id, lat, lon');
      }

      const latitude = parseFloat(String(lat));
      const longitude = parseFloat(String(lon));

      if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
        return res.status(400).send('lat/lon inválidos');
      }

      // Rango físicamente válido — evita persistir coordenadas
      // corruptas que romperían GeofenceAlertService/CollisionRiskService
      // (cálculos de Haversine) o el renderizado del mapa.
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

      // OsmAnd/Traccar Client espera un 200 simple como confirmación
      res.status(200).send('OK');
    } catch (err) {
      console.error('❌ telemetry.routes /gps:', (err as Error).message);
      res.status(500).send('Error procesando posición');
    }
  }

  // GET y POST — algunas versiones de Traccar Client envían POST
  // con los parámetros en el body en vez del query string.
  router.get('/gps', handleGps);
  router.post('/gps', handleGps);

  return router;
}

/**
 * Comparación en tiempo constante para evitar timing attacks
 * sobre la clave compartida de telemetría.
 */
function isValidSharedSecret(providedKey: unknown): boolean {
  if (!providedKey) return false;
  const expected = Buffer.from(env.telemetrySharedSecret as string);
  const provided = Buffer.from(String(providedKey));
  if (expected.length !== provided.length) return false;
  return nodeCrypto.timingSafeEqual(expected, provided);
}

function parseFloatOrDefault<T extends number | null>(value: unknown, fallback: T): number | T {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = parseFloat(String(value));
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseTimestamp(raw: unknown): Date {
  if (!raw) return new Date();
  // Traccar Client envía epoch en milisegundos o segundos según versión
  const num = Number(raw);
  if (!Number.isNaN(num)) {
    return new Date(num > 1e12 ? num : num * 1000);
  }
  const parsed = new Date(String(raw));
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export default buildTelemetryRouter;
