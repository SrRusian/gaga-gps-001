/**
 * reports.routes.js
 *
 * Historial de posiciones (replay) y exportación CSV para el
 * panel admin. La exportación a PDF puede añadirse después con
 * una librería dedicada (p. ej. pdfkit) sin afectar este contrato.
 */

const express = require('express');

function buildReportsRouter({ positionRepo }) {
  const router = express.Router();

  router.get('/history', async (req, res) => {
    try {
      const { deviceId, from, to, limit } = req.query;
      if (!deviceId || !from || !to) {
        return res.status(400).json({ error: 'deviceId, from y to son requeridos' });
      }

      const history = await positionRepo.findHistory({
        deviceId,
        from: new Date(from),
        to: new Date(to),
        limit: limit ? parseInt(limit, 10) : undefined
      });

      res.json(history);
    } catch (err) {
      console.error('❌ reports.routes GET /history:', err.message);
      res.status(500).json({ error: 'Error obteniendo historial' });
    }
  });

  router.get('/history/csv', async (req, res) => {
    try {
      const { deviceId, from, to } = req.query;
      if (!deviceId || !from || !to) {
        return res.status(400).json({ error: 'deviceId, from y to son requeridos' });
      }

      const history = await positionRepo.findHistory({
        deviceId,
        from: new Date(from),
        to: new Date(to)
      });

      const header = 'device_id,latitude,longitude,speed,course,altitude,fix_time\n';
      const csv = header + history.map(p =>
        `${p.device_id},${p.latitude},${p.longitude},${p.speed},${p.course},${p.altitude},${p.fix_time.toISOString ? p.fix_time.toISOString() : p.fix_time}`
      ).join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="historial_${deviceId}.csv"`);
      res.send(csv);
    } catch (err) {
      console.error('❌ reports.routes GET /history/csv:', err.message);
      res.status(500).json({ error: 'Error exportando CSV' });
    }
  });

  return router;
}

module.exports = buildReportsRouter;
