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
}

export default EquipmentActivityRepository;
