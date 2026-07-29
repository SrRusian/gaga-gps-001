/**
 * operator-sessions.routes.js
 *
 * Registro de turnos operador-vehículo. `/active` es pública (la
 * consulta la propia UI de operador antes de iniciar sesión, para
 * saber si ya hay alguien en turno en ese dispositivo) — el resto
 * requiere JWT, igual que el panel admin.
 */

const express = require('express');
const { DeviceNotRegisteredError } = require('../../repositories/OperatorSessionRepository');

function buildOperatorSessionsRouter({ operatorSessionRepo, authMiddleware, requireRole }) {
  const router = express.Router();

  router.get('/active', async (req, res) => {
    try {
      const { deviceId } = req.query;
      if (!deviceId) return res.status(400).json({ error: 'deviceId es requerido' });
      const session = await operatorSessionRepo.findActiveByDevice(deviceId);
      res.json(session);
    } catch (err) {
      console.error('❌ operator-sessions.routes GET /active:', err.message);
      res.status(500).json({ error: 'Error obteniendo turno activo' });
    }
  });

  router.post('/start', authMiddleware, async (req, res) => {
    try {
      const { deviceId } = req.body;
      if (!deviceId) return res.status(400).json({ error: 'deviceId es requerido' });
      const session = await operatorSessionRepo.start({ userId: req.user.id, deviceId });
      res.status(201).json(session);
    } catch (err) {
      if (err instanceof DeviceNotRegisteredError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      console.error('❌ operator-sessions.routes POST /start:', err.message);
      res.status(500).json({ error: 'Error iniciando turno' });
    }
  });

  router.post('/:id/end', authMiddleware, async (req, res) => {
    try {
      const session = await operatorSessionRepo.end(req.params.id);
      if (!session) return res.status(404).json({ error: 'Turno no encontrado o ya cerrado' });
      res.json(session);
    } catch (err) {
      console.error('❌ operator-sessions.routes POST /:id/end:', err.message);
      res.status(500).json({ error: 'Error cerrando turno' });
    }
  });

  // Heartbeat periódico desde la UI de operador — mientras siga
  // llegando, el turno se considera activo indefinidamente; si deja
  // de llegar por más de N días, se cierra automáticamente (ver
  // OperatorSessionRepository.closeStaleSessions, llamado desde app.js).
  router.post('/:id/heartbeat', authMiddleware, async (req, res) => {
    try {
      const session = await operatorSessionRepo.touch(req.params.id);
      if (!session) return res.status(404).json({ error: 'Turno no encontrado o ya cerrado' });
      res.json({ success: true });
    } catch (err) {
      console.error('❌ operator-sessions.routes POST /:id/heartbeat:', err.message);
      res.status(500).json({ error: 'Error registrando actividad' });
    }
  });

  // Reporte de horas trabajadas — por operador y/o por vehículo,
  // solo para supervisión/administración.
  router.get('/report', authMiddleware, requireRole('admin', 'supervisor'), async (req, res) => {
    try {
      const { userId, deviceId, from, to } = req.query;
      if (!from || !to) return res.status(400).json({ error: 'from y to son requeridos' });
      const sessions = await operatorSessionRepo.findReport({
        userId: userId ? parseInt(userId, 10) : undefined,
        deviceId,
        from: new Date(from),
        to: new Date(to)
      });
      res.json(sessions);
    } catch (err) {
      console.error('❌ operator-sessions.routes GET /report:', err.message);
      res.status(500).json({ error: 'Error obteniendo reporte de turnos' });
    }
  });

  return router;
}

module.exports = buildOperatorSessionsRouter;
