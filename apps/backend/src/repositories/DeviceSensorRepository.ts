/**
 * DeviceSensorRepository.ts
 *
 * Persistencia de snapshots de sensores del navegador en la
 * hypertable `device_sensor_snapshots` - independiente de
 * `positions` (protocolo OsmAnd/Traccar Client).
 */
import { query } from '../config/database';

export interface DeviceSensorSnapshotRow {
  id: number;
  device_id: string;
  source: string;
  data: Record<string, unknown>;
  captured_at: Date;
}

class DeviceSensorRepository {
  async save(
    deviceId: string,
    data: Record<string, unknown>,
    source = 'browser',
  ): Promise<DeviceSensorSnapshotRow> {
    try {
      const { rows } = await query<DeviceSensorSnapshotRow>(
        `INSERT INTO device_sensor_snapshots (device_id, source, data)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [deviceId, source, data],
      );
      return rows[0];
    } catch (err) {
      console.error('DeviceSensorRepository.save:', (err as Error).message);
      throw err;
    }
  }

  async findRecentByDevice(deviceId: string, limit = 50): Promise<DeviceSensorSnapshotRow[]> {
    try {
      const { rows } = await query<DeviceSensorSnapshotRow>(
        `SELECT * FROM device_sensor_snapshots
         WHERE device_id = $1
         ORDER BY captured_at DESC
         LIMIT $2`,
        [deviceId, limit],
      );
      return rows;
    } catch (err) {
      console.error('DeviceSensorRepository.findRecentByDevice:', (err as Error).message);
      throw err;
    }
  }
}

export default DeviceSensorRepository;
