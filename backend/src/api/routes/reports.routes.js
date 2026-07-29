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

      // device_id es configurable libremente en la tableta (campo
      // "Device Identifier" de Traccar Client) y no es un dato
      // confiable — se escapa para exportación humana (Excel/Sheets)
      // en km/h para lectura directa por el usuario del reporte.
      const header = 'device_id,latitude,longitude,speed_kmh,course,altitude,fix_time\n';
      const csv = header + history.map(p => [
        csvEscape(p.device_id),
        p.latitude,
        p.longitude,
        (p.speed * 3.6).toFixed(1),
        p.course,
        p.altitude,
        p.fix_time.toISOString ? p.fix_time.toISOString() : p.fix_time
      ].join(',')).join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="historial_${csvEscape(deviceId)}.csv"`);
      res.send(csv);
    } catch (err) {
      console.error('❌ reports.routes GET /history/csv:', err.message);
      res.status(500).json({ error: 'Error exportando CSV' });
    }
  });

  return router;
}

/**
 * Escapa un valor para CSV — evita:
 *  - Inyección de fórmulas en Excel/Sheets (valores que empiezan
 *    con =, +, -, @ se prefijan con un apóstrofo)
 *  - Ruptura de columnas si el valor contiene comas, comillas o saltos de línea
 */
function csvEscape(value) {
  let str = String(value ?? '');
  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n]/.test(str)) {
    str = `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

module.exports = buildReportsRouter;

