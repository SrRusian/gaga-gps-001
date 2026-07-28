/**
 * telemetry.routes.js
 *
 * Receptor propio del protocolo OsmAnd, compatible 100% con lo
 * que ya envía Traccar Client desde las tabletas — solo cambia
 * la URL del servidor, no se toca la app de las tabletas.
 *
 * Traccar Client (protocolo OsmAnd) envía un GET con query params:
 *   id         → identificador único del dispositivo (obligatorio)
 *   lat, lon   → coordenadas (obligatorias)
 *   timestamp  → epoch en segundos o ISO (opcional)
 *   altitude   → metros (opcional)
 *   speed      → metros/segundo, Traccar lo reporta así (opcional)
 *   bearing    → curso en grados (opcional)
 *   accuracy   → precisión en metros (opcional)
 *   batt       → nivel de batería % (opcional)
 *
 * RF asociados: RF-TEL-01, RF-TEL-02
 */

const express = require('express');

function buildTelemetryRouter({ positionProcessor }) {
  const router = express.Router();

  router.get('/gps', async (req, res) => {
    try {
      const { id, lat, lon } = req.query;

      // Validación de parámetros obligatorios del protocolo OsmAnd
      if (!id || lat === undefined || lon === undefined) {
        return res.status(400).send('Faltan parámetros requeridos: id, lat, lon');
      }

      const latitude = parseFloat(lat);
      const longitude = parseFloat(lon);

      if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
        return res.status(400).send('lat/lon inválidos');
      }

      const fixTime = parseTimestamp(req.query.timestamp);

      const position = {
        deviceId: String(id),
        latitude,
        longitude,
        altitude: parseFloatOrDefault(req.query.altitude, 0),
        // Traccar Client reporta velocidad en m/s — se guarda tal cual,
        // la conversión a km/h se hace en la capa de presentación.
        speed: parseFloatOrDefault(req.query.speed, 0),
        course: parseFloatOrDefault(req.query.bearing, 0),
        accuracy: parseFloatOrDefault(req.query.accuracy, 0),
        battery: req.query.batt !== undefined ? parseFloatOrDefault(req.query.batt, null) : null,
        fixTime,
        protocol: 'osmand',
        valid: true,
        attributes: {}
      };

      await positionProcessor.process(position);

      // OsmAnd/Traccar Client espera un 200 simple como confirmación
      res.status(200).send('OK');
    } catch (err) {
      console.error('❌ telemetry.routes /gps:', err.message);
      res.status(500).send('Error procesando posición');
    }
  });

  return router;
}

function parseFloatOrDefault(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseTimestamp(raw) {
  if (!raw) return new Date();
  // Traccar Client envía epoch en milisegundos o segundos según versión
  const num = Number(raw);
  if (!Number.isNaN(num)) {
    return new Date(num > 1e12 ? num : num * 1000);
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

module.exports = buildTelemetryRouter;
