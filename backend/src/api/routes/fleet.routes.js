/**
 * fleet.routes.js
 *
 * Estado general de la flota y control de parada preventiva
 * colectiva (RF-ALR-11). Extraído de app.js sin cambiar su
 * comportamiento.
 */

const express = require('express');

function buildFleetRouter({ preventiveStopService, fleetState }) {
  const router = express.Router();

  router.get('/state', async (req, res) => {
    try {
      const fleet = await fleetState.getAll();
      res.json({ positions: Object.values(fleet), timestamp: new Date().toISOString() });
    } catch (err) {
      console.error('❌ fleet.routes GET /state:', err.message);
      res.status(500).json({ error: 'Error obteniendo estado de flota' });
    }
  });

  router.post('/stop', (req, res) => {
    const { reason } = req.body;
    preventiveStopService.activate(
      reason || 'Activado manualmente por supervisor',
      'supervisor'
    );
    res.json({ success: true, status: preventiveStopService.getStatus() });
  });

  router.post('/resume', (req, res) => {
    preventiveStopService.deactivate('supervisor');
    res.json({ success: true, status: preventiveStopService.getStatus() });
  });

  router.get('/stop/status', (req, res) => {
    res.json(preventiveStopService.getStatus());
  });

  return router;
}

module.exports = buildFleetRouter;
