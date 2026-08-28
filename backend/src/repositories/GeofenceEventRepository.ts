import { query } from '../config/database';

export interface GeofenceEventRow {
  id: number;
  device_id: string;
  geofence_id: number | null;
  event_type: 'enter' | 'exit';
  severity: string | null;
  occurred_at: Date;
}

class GeofenceEventRepository {
  async record({
    deviceId,
    geofenceId,
    eventType,
    severity,
  }: {
    deviceId: string;
    geofenceId: number | null;
    eventType: 'enter' | 'exit';
    severity?: string | null;
  }): Promise<GeofenceEventRow> {
    try {
      const { rows } = await query<GeofenceEventRow>(
        `INSERT INTO geofence_events (device_id, geofence_id, event_type, severity)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [deviceId, geofenceId, eventType, severity || null],
      );
      return rows[0];
    } catch (err) {
      console.error('GeofenceEventRepository.record:', (err as Error).message);
      throw err;
    }
  }

  async findByDeviceAndRange({
    deviceId,
    from,
    to,
  }: {
    deviceId: string;
    from: Date | string;
    to: Date | string;
  }): Promise<GeofenceEventRow[]> {
    try {
      const { rows } = await query<GeofenceEventRow>(
        `SELECT * FROM geofence_events
         WHERE device_id = $1 AND occurred_at BETWEEN $2 AND $3
         ORDER BY occurred_at ASC`,
        [deviceId, from, to],
      );
      return rows;
    } catch (err) {
      console.error('GeofenceEventRepository.findByDeviceAndRange:', (err as Error).message);
      throw err;
    }
  }
}

export default GeofenceEventRepository;
