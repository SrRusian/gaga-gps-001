/**
 * OperatorSessionRepository.ts
 *
 * Responsabilidad: Registrar turnos operador-vehículo - quién
 * operó qué dispositivo y durante cuánto tiempo, independiente
 * del historial de posiciones GPS (positions) y del login del
 * panel admin. Ver db/migrations/004_operator_sessions.sql.
 */
import { pool, query } from '../config/database';

export interface OperatorSessionRow {
  id: number;
  user_id: number;
  device_id: string;
  shift_id: number | null;
  started_at: Date;
  ended_at: Date | null;
  last_seen_at: Date;
}

export interface OperatorSessionWithUser extends OperatorSessionRow {
  user_name: string;
  user_email: string;
}

export interface OperatorSessionReportRow extends OperatorSessionWithUser {
  duration_seconds: number;
}

/**
 * Error específico cuando se intenta iniciar un turno en un
 * dispositivo que todavía no ha reportado ninguna posición GPS
 * (no auto-registrado aún en `devices`) - permite a la ruta
 * responder con un mensaje claro en vez de un 500 genérico.
 */
export class DeviceNotRegisteredError extends Error {
  code = 'DEVICE_NOT_REGISTERED';

  constructor(deviceId: string) {
    super(
      `El dispositivo "${deviceId}" aún no ha reportado ninguna posición GPS - espera unos segundos a que Traccar Client se conecte e intenta de nuevo`,
    );
  }
}

class OperatorSessionRepository {
  /**
   * Inicia un turno. Si el dispositivo ya tenía un turno abierto
   * (p. ej. el operador anterior olvidó cerrar sesión), se cierra
   * automáticamente antes de abrir el nuevo - evita turnos
   * superpuestos que ensuciarían los reportes de horas trabajadas.
   */
  async start({
    userId,
    deviceId,
    shiftId = null,
  }: {
    userId: number;
    deviceId: string;
    shiftId?: number | null;
  }): Promise<OperatorSessionRow> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE operator_sessions SET ended_at = NOW() WHERE device_id = $1 AND ended_at IS NULL`,
        [deviceId],
      );
      const { rows } = await client.query<OperatorSessionRow>(
        `INSERT INTO operator_sessions (user_id, device_id, shift_id)
         VALUES ($1, $2, $3) RETURNING *`,
        [userId, deviceId, shiftId],
      );
      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // 23503 = foreign_key_violation - el device_id aún no existe en `devices`
      if ((err as { code?: string }).code === '23503') {
        throw new DeviceNotRegisteredError(deviceId);
      }
      console.error('OperatorSessionRepository.start:', (err as Error).message);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Cierra un turno explícitamente (botón "Finalizar turno").
   */
  async end(sessionId: number): Promise<OperatorSessionRow | null> {
    try {
      const { rows } = await query<OperatorSessionRow>(
        `UPDATE operator_sessions SET ended_at = NOW()
         WHERE id = $1 AND ended_at IS NULL RETURNING *`,
        [sessionId],
      );
      return rows[0] || null;
    } catch (err) {
      console.error('OperatorSessionRepository.end:', (err as Error).message);
      throw err;
    }
  }

  /**
   * Marca actividad reciente en un turno (heartbeat periódico desde
   * la UI de operador mientras la pestaña sigue abierta) - es lo
   * que permite que el turno persista indefinidamente durante uso
   * normal, mientras closeStaleSessions() descarta los realmente
   * abandonados.
   */
  async touch(sessionId: number): Promise<OperatorSessionRow | null> {
    try {
      const { rows } = await query<OperatorSessionRow>(
        `UPDATE operator_sessions SET last_seen_at = NOW()
         WHERE id = $1 AND ended_at IS NULL RETURNING *`,
        [sessionId],
      );
      return rows[0] || null;
    } catch (err) {
      console.error('OperatorSessionRepository.touch:', (err as Error).message);
      throw err;
    }
  }

  /**
   * Cierra automáticamente turnos sin actividad (sin heartbeat) por
   * más de `maxIdleDays` - protege contra tabletas perdidas/app
   * cerrada sin cerrar turno. Se cierra con la marca de tiempo de la
   * última actividad real (last_seen_at), no "ahora", para que el
   * reporte de horas refleje cuándo realmente se dejó de usar.
   */
  async closeStaleSessions(
    maxIdleDays: number,
  ): Promise<Pick<OperatorSessionRow, 'id' | 'device_id' | 'user_id'>[]> {
    try {
      const { rows } = await query<Pick<OperatorSessionRow, 'id' | 'device_id' | 'user_id'>>(
        `UPDATE operator_sessions SET ended_at = last_seen_at
         WHERE ended_at IS NULL AND last_seen_at < NOW() - ($1 * INTERVAL '1 day')
         RETURNING id, device_id, user_id`,
        [maxIdleDays],
      );
      if (rows.length > 0) {
        console.log(
          `${rows.length} turno(s) cerrado(s) automáticamente por inactividad (${maxIdleDays} días)`,
        );
      }
      return rows;
    } catch (err) {
      console.error('OperatorSessionRepository.closeStaleSessions:', (err as Error).message);
      throw err;
    }
  }

  /**
   * Turno actualmente abierto de un dispositivo (si lo hay) - usado
   * al cargar la UI de operador para saber si ya hay alguien en turno.
   */
  async findActiveByDevice(deviceId: string): Promise<OperatorSessionWithUser | null> {
    try {
      const { rows } = await query<OperatorSessionWithUser>(
        `SELECT s.*, u.name AS user_name, u.email AS user_email
         FROM operator_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.device_id = $1 AND s.ended_at IS NULL`,
        [deviceId],
      );
      return rows[0] || null;
    } catch (err) {
      console.error('OperatorSessionRepository.findActiveByDevice:', (err as Error).message);
      throw err;
    }
  }

  /**
   * Turnos de operador actualmente abiertos bajo un turno programado
   * (shift) - el roster que ve un Supervisor de Proyecto en su panel.
   */
  async findActiveByShift(shiftId: number): Promise<OperatorSessionWithUser[]> {
    try {
      const { rows } = await query<OperatorSessionWithUser>(
        `SELECT s.*, u.name AS user_name, u.email AS user_email
         FROM operator_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.shift_id = $1 AND s.ended_at IS NULL`,
        [shiftId],
      );
      return rows;
    } catch (err) {
      console.error('OperatorSessionRepository.findActiveByShift:', (err as Error).message);
      throw err;
    }
  }

  /**
   * Reporte de turnos - filtrable por operador y/o dispositivo y
   * rango de fechas, con duración calculada en segundos. Base para
   * "horas trabajadas por persona" y "quién operó este vehículo".
   */
  async findReport({
    userId,
    deviceId,
    from,
    to,
  }: {
    userId?: number;
    deviceId?: string;
    from: Date | string;
    to: Date | string;
  }): Promise<OperatorSessionReportRow[]> {
    try {
      const conditions = ['s.started_at <= $1', 'COALESCE(s.ended_at, NOW()) >= $2'];
      const params: unknown[] = [to, from];

      if (userId) {
        params.push(userId);
        conditions.push(`s.user_id = $${params.length}`);
      }
      if (deviceId) {
        params.push(deviceId);
        conditions.push(`s.device_id = $${params.length}`);
      }

      const { rows } = await query<OperatorSessionReportRow>(
        `SELECT s.*, u.name AS user_name, u.email AS user_email,
                EXTRACT(EPOCH FROM (COALESCE(s.ended_at, NOW()) - s.started_at)) AS duration_seconds
         FROM operator_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY s.started_at DESC`,
        params,
      );
      return rows;
    } catch (err) {
      console.error('OperatorSessionRepository.findReport:', (err as Error).message);
      throw err;
    }
  }
}

export default OperatorSessionRepository;
