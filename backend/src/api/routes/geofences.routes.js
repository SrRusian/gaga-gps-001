/**
 * geofences.routes.js
 *
 * CRUD de geocercas persistidas en PostgreSQL. Cada cambio se
 * refleja de inmediato en GeofenceAlertService (memoria) y se
 * notifica a todos los clientes conectados vía Socket.io.
 *
 * Soporta 3 formas: círculo (centerLat/centerLon/radiusMeters),
 * polígono (geometry GeoJSON Polygon) y polilínea/corredor
 * (geometry GeoJSON LineString + corridorWidthMeters).
 *
 * RF asociados: RF-ALR-02, RF-ALR-03
 */

const express = require('express');
const GeofenceRepository = require('../../repositories/GeofenceRepository');
const { geofencesToGeoJSON, geofencesToKml, geoJSONToGeofenceInputs, kmlToGeofenceInputs } = require('../../utils/geoFormats');

function buildGeofencesRouter({ geofenceRepo, geofenceService, socketServer }) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const geofences = await geofenceRepo.findAllActive();
      res.json(geofences);
    } catch (err) {
      console.error('❌ geofences.routes GET /:', err.message);
      res.status(500).json({ error: 'Error obteniendo geocercas' });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { name, type, shapeType = 'circle', centerLat, centerLon, radiusMeters, geometry, corridorWidthMeters, corridorDangerMarginMeters } = req.body;

      if (!name || !type) {
        return res.status(400).json({ error: 'name y type son requeridos' });
      }

      const validationError = validateShapeFields(shapeType, { centerLat, centerLon, radiusMeters, geometry, corridorWidthMeters });
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }

      const geofence = await geofenceRepo.create({
        name, type, shapeType, centerLat, centerLon, radiusMeters, geometry, corridorWidthMeters, corridorDangerMarginMeters
      });

      // Reflejar en memoria para evaluación en tiempo real (GeofenceAlertService)
      geofenceService.addGeofence(GeofenceRepository.toMemoryFormat(geofence));

      socketServer.broadcast('geofences:update', geofenceService.activeGeofences);
      res.status(201).json(geofence);
    } catch (err) {
      console.error('❌ geofences.routes POST /:', err.message);
      res.status(500).json({ error: 'Error creando geocerca' });
    }
  });

  router.patch('/:id', async (req, res) => {
    try {
      const { name, type, active, centerLat, centerLon, radiusMeters, geometry, corridorWidthMeters, corridorDangerMarginMeters } = req.body;

      const geofence = await geofenceRepo.update(req.params.id, {
        name, type, active, centerLat, centerLon, radiusMeters, geometry, corridorWidthMeters, corridorDangerMarginMeters
      });
      if (!geofence) return res.status(404).json({ error: 'Geocerca no encontrada' });

      // Reflejar el cambio en memoria y notificar en vivo a
      // Operador/Supervisor (misma mecánica que crear/eliminar)
      if (geofence.active) {
        geofenceService.addGeofence(GeofenceRepository.toMemoryFormat(geofence));
      } else {
        geofenceService.removeGeofence(geofence.id);
      }
      socketServer.broadcast('geofences:update', geofenceService.activeGeofences);

      res.json(geofence);
    } catch (err) {
      console.error('❌ geofences.routes PATCH /:id:', err.message);
      res.status(500).json({ error: 'Error actualizando geocerca' });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      await geofenceRepo.delete(req.params.id);
      geofenceService.removeGeofence(parseInt(req.params.id, 10));
      socketServer.broadcast('geofences:update', geofenceService.activeGeofences);
      res.json({ success: true });
    } catch (err) {
      console.error('❌ geofences.routes DELETE /:id:', err.message);
      res.status(500).json({ error: 'Error eliminando geocerca' });
    }
  });

  // ── Exportación en formatos estándar ────────────────────────────
  // GeoJSON — formato principal, nativo en JS/QGIS/Leaflet/Mapbox
  router.get('/export.geojson', async (req, res) => {
    try {
      const geofences = await geofenceRepo.findAllActive();
      res.setHeader('Content-Type', 'application/geo+json');
      res.setHeader('Content-Disposition', 'attachment; filename="geocercas.geojson"');
      res.json(geofencesToGeoJSON(geofences));
    } catch (err) {
      console.error('❌ geofences.routes GET /export.geojson:', err.message);
      res.status(500).json({ error: 'Error exportando GeoJSON' });
    }
  });

  // KML — formato usado en topografía/minería y Google Earth
  router.get('/export.kml', async (req, res) => {
    try {
      const geofences = await geofenceRepo.findAllActive();
      res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
      res.setHeader('Content-Disposition', 'attachment; filename="geocercas.kml"');
      res.send(geofencesToKml(geofences));
    } catch (err) {
      console.error('❌ geofences.routes GET /export.kml:', err.message);
      res.status(500).json({ error: 'Error exportando KML' });
    }
  });

  // ── Importación — GeoJSON FeatureCollection o texto KML ─────────
  // Body: { format: 'geojson', data: <FeatureCollection> } o
  //       { format: 'kml', data: '<contenido del archivo .kml>' }
  router.post('/import', async (req, res) => {
    try {
      const { format, data } = req.body;

      let inputs, errors;
      if (format === 'geojson') {
        ({ inputs, errors } = geoJSONToGeofenceInputs(data));
      } else if (format === 'kml') {
        ({ inputs, errors } = kmlToGeofenceInputs(data));
      } else {
        return res.status(400).json({ error: "format debe ser 'geojson' o 'kml'" });
      }

      const created = [];
      for (const input of inputs) {
        const geofence = await geofenceRepo.create(input);
        geofenceService.addGeofence(GeofenceRepository.toMemoryFormat(geofence));
        created.push(geofence);
      }

      if (created.length > 0) {
        socketServer.broadcast('geofences:update', geofenceService.activeGeofences);
      }

      res.status(created.length > 0 ? 201 : 400).json({
        imported: created.length,
        skipped: errors.length,
        errors,
        geofences: created
      });
    } catch (err) {
      console.error('❌ geofences.routes POST /import:', err.message);
      res.status(500).json({ error: 'Error importando geocercas — verifique el formato del archivo' });
    }
  });

  return router;
}

/**
 * Validación mínima de los campos requeridos según la forma —
 * evita persistir geometría malformada que rompería geometry.js
 * al evaluarse en tiempo real contra las posiciones entrantes.
 */
function validateShapeFields(shapeType, { centerLat, centerLon, radiusMeters, geometry, corridorWidthMeters }) {
  if (shapeType === 'circle') {
    if (centerLat === undefined || centerLon === undefined || !radiusMeters) {
      return 'Círculo requiere centerLat, centerLon y radiusMeters';
    }
    return null;
  }

  if (shapeType === 'polygon') {
    if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates?.[0]) || geometry.coordinates[0].length < 3) {
      return 'Polígono requiere geometry GeoJSON tipo Polygon con al menos 3 puntos';
    }
    return null;
  }

  if (shapeType === 'polyline') {
    if (!geometry || geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) {
      return 'Polilínea requiere geometry GeoJSON tipo LineString con al menos 2 puntos';
    }
    if (!corridorWidthMeters || corridorWidthMeters <= 0) {
      return 'Polilínea requiere corridorWidthMeters (ancho del corredor autorizado, en metros)';
    }
    return null;
  }

  return `shapeType inválido: ${shapeType}`;
}

module.exports = buildGeofencesRouter;

