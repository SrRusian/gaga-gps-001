/**
 * devices.routes.js
 *
 * CRUD completo de dispositivos (tabletas) en PostgreSQL.
 * Reemplaza la gestión de dispositivos del panel de Traccar.
 */

const express = require('express');
const { DeviceHasPositionsError } = require('../../repositories/DeviceRepository');

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
      // ?force=true purga también el historial de posiciones —
      // acción destructiva explícita, no es el comportamiento
      // por defecto (se preserva el historial para auditoría).
      const force = req.query.force === 'true';
      await deviceRepo.delete(req.params.id, { force });
      res.json({ success: true });
    } catch (err) {
      if (err instanceof DeviceHasPositionsError) {
        return res.status(409).json({
          error: 'El dispositivo tiene posiciones registradas — no se puede eliminar sin purgar su historial',
          code: err.code,
          hint: 'Reintente con ?force=true si desea eliminar también el historial de posiciones'
        });
      }
      console.error('❌ devices.routes DELETE /:id:', err.message);
      res.status(500).json({ error: 'Error eliminando dispositivo' });
    }
  });

  return router;
}

module.exports = buildDevicesRouter;
