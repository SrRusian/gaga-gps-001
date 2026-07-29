/**
 * OperatorSessionRepository.js
 *
 * Responsabilidad: Registrar turnos operador-vehículo — quién
 * operó qué dispositivo y durante cuánto tiempo, independiente
 * del historial de posiciones GPS (positions) y del login del
 * panel admin. Ver db/migrations/004_operator_sessions.sql.
 */

const { pool, query } = require('../config/database');

/**
 * Error específico cuando se intenta iniciar un turno en un
 * dispositivo que todavía no ha reportado ninguna posición GPS
 * (no auto-registrado aún en `devices`) — permite a la ruta
 * responder con un mensaje claro en vez de un 500 genérico.
 */
class DeviceNotRegisteredError extends Error {
  constructor(deviceId) {
    super(`El dispositivo "${deviceId}" aún no ha reportado ninguna posición GPS — espera unos segundos a que Traccar Client se conecte e intenta de nuevo`);
    this.code = 'DEVICE_NOT_REGISTERED';
  }
}

class OperatorSessionRepository {

  /**
   * Inicia un turno. Si el dispositivo ya tenía un turno abierto
   * (p. ej. el operador anterior olvidó cerrar sesión), se cierra
   * automáticamente antes de abrir el nuevo — evita turnos
   * superpuestos que ensuciarían los reportes de horas trabajadas.
   */
  async start({ userId, deviceId }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE operator_sessions SET ended_at = NOW()
         WHERE device_id = $1 AND ended_at IS NULL`,
        [deviceId]
      );
      const { rows } = await client.query(
        `INSERT INTO operator_sessions (user_id, device_id)
         VALUES ($1, $2) RETURNING *`,
        [userId, deviceId]
      );
      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // 23503 = foreign_key_violation — el device_id aún no existe en `devices`
      if (err.code === '23503') {
        throw new DeviceNotRegisteredError(deviceId);
      }
      console.error('❌ OperatorSessionRepository.start:', err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Cierra un turno explícitamente (botón "Finalizar turno").
   */
  async end(sessionId) {
    try {
      const { rows } = await query(
        `UPDATE operator_sessions SET ended_at = NOW()
         WHERE id = $1 AND ended_at IS NULL RETURNING *`,
        [sessionId]
      );
      return rows[0] || null;
    } catch (err) {
      console.error('❌ OperatorSessionRepository.end:', err.message);
      throw err;
    }
  }

  /**
   * Marca actividad reciente en un turno (heartbeat periódico desde
   * la UI de operador mientras la pestaña sigue abierta) — es lo
   * que permite que el turno persista indefinidamente durante uso
   * normal, mientras closeStaleSessions() descarta los realmente
   * abandonados.
   */
  async touch(sessionId) {
    try {
      const { rows } = await query(
        `UPDATE operator_sessions SET last_seen_at = NOW()
         WHERE id = $1 AND ended_at IS NULL RETURNING *`,
        [sessionId]
      );
      return rows[0] || null;
    } catch (err) {
      console.error('❌ OperatorSessionRepository.touch:', err.message);
      throw err;
    }
  }

  /**
   * Cierra automáticamente turnos sin actividad (sin heartbeat) por
   * más de `maxIdleDays` — protege contra tabletas perdidas/app
   * cerrada sin cerrar turno. Se cierra con la marca de tiempo de la
   * última actividad real (last_seen_at), no "ahora", para que el
   * reporte de horas refleje cuándo realmente se dejó de usar.
   */
  async closeStaleSessions(maxIdleDays) {
    try {
      const { rows } = await query(
        `UPDATE operator_sessions SET ended_at = last_seen_at
         WHERE ended_at IS NULL AND last_seen_at < NOW() - ($1 * INTERVAL '1 day')
         RETURNING id, device_id, user_id`,
        [maxIdleDays]
      );
      if (rows.length > 0) {
        console.log(`🧹 ${rows.length} turno(s) cerrado(s) automáticamente por inactividad (${maxIdleDays} días)`);
      }
      return rows;
    } catch (err) {
      console.error('❌ OperatorSessionRepository.closeStaleSessions:', err.message);
      throw err;
    }
  }

  /**
   * Turno actualmente abierto de un dispositivo (si lo hay) — usado
   * al cargar la UI de operador para saber si ya hay alguien en turno.
   */
  async findActiveByDevice(deviceId) {
    try {
      const { rows } = await query(
        `SELECT s.*, u.name AS user_name, u.email AS user_email
         FROM operator_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.device_id = $1 AND s.ended_at IS NULL`,
        [deviceId]
      );
      return rows[0] || null;
    } catch (err) {
      console.error('❌ OperatorSessionRepository.findActiveByDevice:', err.message);
      throw err;
    }
  }

  /**
   * Reporte de turnos — filtrable por operador y/o dispositivo y
   * rango de fechas, con duración calculada en segundos. Base para
   * "horas trabajadas por persona" y "quién operó este vehículo".
   */
  async findReport({ userId, deviceId, from, to }) {
    try {
      const conditions = ['s.started_at <= $1', 'COALESCE(s.ended_at, NOW()) >= $2'];
      const params = [to, from];

      if (userId) {
        params.push(userId);
        conditions.push(`s.user_id = $${params.length}`);
      }
      if (deviceId) {
        params.push(deviceId);
        conditions.push(`s.device_id = $${params.length}`);
      }

      const { rows } = await query(
        `SELECT s.*, u.name AS user_name, u.email AS user_email,
                EXTRACT(EPOCH FROM (COALESCE(s.ended_at, NOW()) - s.started_at)) AS duration_seconds
         FROM operator_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY s.started_at DESC`,
        params
      );
      return rows;
    } catch (err) {
      console.error('❌ OperatorSessionRepository.findReport:', err.message);
      throw err;
    }
  }
}

module.exports = OperatorSessionRepository;
module.exports.DeviceNotRegisteredError = DeviceNotRegisteredError;
