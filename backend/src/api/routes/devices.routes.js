/**
 * devices.routes.js
 *
 * CRUD completo de dispositivos (tabletas) en PostgreSQL.
 * Reemplaza la gestión de dispositivos del panel de Traccar.
 */

const express = require('express');

function buildDevicesRouter({ deviceRepo }) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const devices = await deviceRepo.findAll();
      res.json(devices);
    } catch (err) {
      console.error('❌ devices.routes GET /:', err.message);
      res.status(500).json({ error: 'Error obteniendo dispositivos' });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const device = await deviceRepo.findById(req.params.id);
      if (!device) return res.status(404).json({ error: 'Dispositivo no encontrado' });
      res.json(device);
    } catch (err) {
      console.error('❌ devices.routes GET /:id:', err.message);
      res.status(500).json({ error: 'Error obteniendo dispositivo' });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { uniqueId, name, type, attributes } = req.body;
      if (!uniqueId || !name) {
        return res.status(400).json({ error: 'uniqueId y name son requeridos' });
      }
      const device = await deviceRepo.create({ uniqueId, name, type, attributes });
      res.status(201).json(device);
    } catch (err) {
      console.error('❌ devices.routes POST /:', err.message);
      res.status(500).json({ error: 'Error creando dispositivo' });
    }
  });

  router.patch('/:id', async (req, res) => {
    try {
      const { name, type, attributes } = req.body;
      const device = await deviceRepo.update(req.params.id, { name, type, attributes });
      if (!device) return res.status(404).json({ error: 'Dispositivo no encontrado' });
      res.json(device);
    } catch (err) {
      console.error('❌ devices.routes PATCH /:id:', err.message);
      res.status(500).json({ error: 'Error actualizando dispositivo' });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      await deviceRepo.delete(req.params.id);
      res.json({ success: true });
    } catch (err) {
      console.error('❌ devices.routes DELETE /:id:', err.message);
      res.status(500).json({ error: 'Error eliminando dispositivo' });
    }
  });

  return router;
}

module.exports = buildDevicesRouter;
