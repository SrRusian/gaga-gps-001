import { pool, query } from '../config/database';

export interface DeviceProjectHistoryRow {
  id: number;
  device_id: string;
  project_id: number | null;
  valid_from: Date;
  valid_to: Date | null;
  changed_by: number | null;
}

class DeviceProjectHistoryRepository {
  async recordChange({
    deviceId,
    projectId,
    changedBy = null,
  }: {
    deviceId: string;
    projectId: number | null;
    changedBy?: number | null;
  }): Promise<DeviceProjectHistoryRow> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE device_project_history SET valid_to = NOW() WHERE device_id = $1 AND valid_to IS NULL`,
        [deviceId],
      );
      const { rows } = await client.query<DeviceProjectHistoryRow>(
        `INSERT INTO device_project_history (device_id, project_id, changed_by)
         VALUES ($1, $2, $3) RETURNING *`,
        [deviceId, projectId, changedBy],
      );
      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('DeviceProjectHistoryRepository.recordChange:', (err as Error).message);
      throw err;
    } finally {
      client.release();
    }
  }

  async findByDevice(deviceId: string): Promise<DeviceProjectHistoryRow[]> {
    try {
      const { rows } = await query<DeviceProjectHistoryRow>(
        `SELECT * FROM device_project_history WHERE device_id = $1 ORDER BY valid_from DESC`,
        [deviceId],
      );
      return rows;
    } catch (err) {
      console.error('DeviceProjectHistoryRepository.findByDevice:', (err as Error).message);
      throw err;
    }
  }
}

export default DeviceProjectHistoryRepository;
