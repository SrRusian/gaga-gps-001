import { query } from '../config/database';

export type ActivityType = 'productive' | 'unproductive' | 'maintenance';

export interface EquipmentActivitySegmentRow {
  id: number;
  device_id: string;
  operator_session_id: number | null;
  activity_type: ActivityType;
  started_at: Date;
  ended_at: Date | null;
  notes: string | null;
}

class EquipmentActivityRepository {
  async create({
    deviceId,
    operatorSessionId,
    activityType,
    notes,
  }: {
    deviceId: string;
    operatorSessionId?: number | null;
    activityType: ActivityType;
    notes?: string | null;
  }): Promise<EquipmentActivitySegmentRow> {
    try {
      const { rows } = await query<EquipmentActivitySegmentRow>(
        `INSERT INTO equipment_activity_segments (device_id, operator_session_id, activity_type, notes)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [deviceId, operatorSessionId ?? null, activityType, notes ?? null],
      );
      return rows[0];
    } catch (err) {
      console.error('EquipmentActivityRepository.create:', (err as Error).message);
      throw err;
    }
  }

  async findByDevice(deviceId: string, from: Date | string, to: Date | string): Promise<EquipmentActivitySegmentRow[]> {
    try {
      const { rows } = await query<EquipmentActivitySegmentRow>(
        `SELECT * FROM equipment_activity_segments
         WHERE device_id = $1 AND started_at BETWEEN $2 AND $3
         ORDER BY started_at ASC`,
        [deviceId, from, to],
      );
      return rows;
    } catch (err) {
      console.error('EquipmentActivityRepository.findByDevice:', (err as Error).message);
      throw err;
    }
  }

  // cierra el segmento abierto (si hay uno) - usado al clasificar un cambio de actividad o al
  // cerrar el turno del operador, para no dejar un segmento "colgado" sin ended_at
  async closeOpen(deviceId: string): Promise<void> {
    try {
      await query(
        `UPDATE equipment_activity_segments SET ended_at = NOW()
         WHERE device_id = $1 AND ended_at IS NULL`,
        [deviceId],
      );
    } catch (err) {
      console.error('EquipmentActivityRepository.closeOpen:', (err as Error).message);
      throw err;
    }
  }

  // tiempo por activity_type recortado al rango [from, to] - un segmento que empieza antes o
  // sigue abierto despues del rango solo cuenta la parte que cae dentro
  async summarizeByDevice(
    deviceId: string,
    from: Date | string,
    to: Date | string,
  ): Promise<Record<ActivityType, number>> {
    try {
      const { rows } = await query<{ activity_type: ActivityType; duration_seconds: number }>(
        `SELECT activity_type,
                SUM(GREATEST(EXTRACT(EPOCH FROM (
                  LEAST(COALESCE(ended_at, NOW()), $3::timestamptz) - GREATEST(started_at, $2::timestamptz)
                )), 0)) AS duration_seconds
         FROM equipment_activity_segments
         WHERE device_id = $1 AND started_at <= $3 AND COALESCE(ended_at, NOW()) >= $2
         GROUP BY activity_type`,
        [deviceId, from, to],
      );
      return toSummary(rows);
    } catch (err) {
      console.error('EquipmentActivityRepository.summarizeByDevice:', (err as Error).message);
      throw err;
    }
  }

  // igual que summarizeByDevice pero uniendo por operator_sessions.user_id - un operador puede
  // haber usado mas de un vehiculo en el rango
  async summarizeByOperatorSession(
    userId: number,
    from: Date | string,
    to: Date | string,
  ): Promise<Record<ActivityType, number>> {
    try {
      const { rows } = await query<{ activity_type: ActivityType; duration_seconds: number }>(
        `SELECT s.activity_type,
                SUM(GREATEST(EXTRACT(EPOCH FROM (
                  LEAST(COALESCE(s.ended_at, NOW()), $3::timestamptz) - GREATEST(s.started_at, $2::timestamptz)
                )), 0)) AS duration_seconds
         FROM equipment_activity_segments s
         JOIN operator_sessions os ON os.id = s.operator_session_id
         WHERE os.user_id = $1 AND s.started_at <= $3 AND COALESCE(s.ended_at, NOW()) >= $2
         GROUP BY s.activity_type`,
        [userId, from, to],
      );
      return toSummary(rows);
    } catch (err) {
      console.error('EquipmentActivityRepository.summarizeByOperatorSession:', (err as Error).message);
      throw err;
    }
  }
}

function toSummary(
  rows: { activity_type: ActivityType; duration_seconds: number }[],
): Record<ActivityType, number> {
  const summary: Record<ActivityType, number> = { productive: 0, unproductive: 0, maintenance: 0 };
  for (const row of rows) {
    summary[row.activity_type] = Number(row.duration_seconds);
  }
  return summary;
}

export default EquipmentActivityRepository;
