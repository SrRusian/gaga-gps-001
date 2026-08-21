import { pool, query } from '../config/database';

export interface OperatorSessionRow {
  id: number;
  user_id: number;
  device_id: string;
  shift_id: number | null;
  project_id: number | null;
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

export class DeviceNotRegisteredError extends Error {
  code = 'DEVICE_NOT_REGISTERED';

  constructor(deviceId: string) {
    super(
      `El dispositivo "${deviceId}" aún no ha reportado ninguna posición GPS - espera unos segundos a que Traccar Client se conecte e intenta de nuevo`,
    );
  }
}

class OperatorSessionRepository {
  async start({
    userId,
    deviceId,
    shiftId = null,
    projectId = null,
  }: {
    userId: number;
    deviceId: string;
    shiftId?: number | null;
    projectId?: number | null;
  }): Promise<OperatorSessionRow> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE operator_sessions SET ended_at = NOW() WHERE device_id = $1 AND ended_at IS NULL`,
        [deviceId],
      );
      const { rows } = await client.query<OperatorSessionRow>(
        `INSERT INTO operator_sessions (user_id, device_id, shift_id, project_id)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [userId, deviceId, shiftId, projectId],
      );
      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if ((err as { code?: string }).code === '23503') {
        throw new DeviceNotRegisteredError(deviceId);
      }
      console.error('OperatorSessionRepository.start:', (err as Error).message);
      throw err;
    } finally {
      client.release();
    }
  }

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
