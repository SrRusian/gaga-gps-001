/**
 * geofences.routes.js
 *
 * CRUD de geocercas persistidas en PostgreSQL. Cada cambio se
 * refleja de inmediato en GeofenceAlertService (memoria) y se
 * notifica a todos los clientes conectados vía Socket.io.
 *
 * RF asociados: RF-ALR-02, RF-ALR-03
 */

const express = require('express');

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
      const { name, type, centerLat, centerLon, radiusMeters } = req.body;
      if (!name || !type || centerLat === undefined || centerLon === undefined || !radiusMeters) {
        return res.status(400).json({ error: 'Faltan campos requeridos' });
      }

      const geofence = await geofenceRepo.create({ name, type, centerLat, centerLon, radiusMeters });

      // Reflejar en memoria para evaluación en tiempo real (GeofenceAlertService)
      geofenceService.addGeofence({
        id: geofence.id,
        name: geofence.name,
        type: geofence.type,
        center: { lat: geofence.center_lat, lon: geofence.center_lon },
        radiusMeters: geofence.radius_meters
      });

      socketServer.broadcast('geofences:update', geofenceService.activeGeofences);
      res.status(201).json(geofence);
    } catch (err) {
      console.error('❌ geofences.routes POST /:', err.message);
      res.status(500).json({ error: 'Error creando geocerca' });
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

  return router;
}

module.exports = buildGeofencesRouter;
