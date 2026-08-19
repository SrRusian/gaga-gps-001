import { query } from '../config/database';

export interface PositionRow {
  id: number;
  device_id: string;
  latitude: number;
  longitude: number;
  altitude: number;
  speed: number;
  course: number;
  accuracy: number;
  battery: number | null;
  fix_time: Date;
  protocol: string;
  valid: boolean;
  attributes: Record<string, unknown>;
}

export interface PositionInput {
  deviceId: string;
  latitude: number;
  longitude: number;
  altitude?: number;
  speed?: number;
  course?: number;
  accuracy?: number;
  battery?: number | null;
  fixTime?: Date | string;
  protocol?: string;
  valid?: boolean;
  attributes?: Record<string, unknown>;
}

class PositionRepository {
  async save(position: PositionInput): Promise<PositionRow> {
    try {
      const { rows } = await query<PositionRow>(
        `INSERT INTO positions
           (device_id, latitude, longitude, altitude, speed, course,
            accuracy, battery, fix_time, protocol, valid, attributes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          position.deviceId,
          position.latitude,
          position.longitude,
          position.altitude || 0,
          position.speed || 0,
          position.course || 0,
          position.accuracy || 0,
          position.battery ?? null,
          position.fixTime || new Date(),
          position.protocol || 'osmand',
          position.valid !== false,
          position.attributes || {},
        ],
      );
      return rows[0];
    } catch (err) {
      console.error('PositionRepository.save:', (err as Error).message);
      throw err;
    }
  }

  async findLatestByDevice(deviceId: string): Promise<PositionRow | null> {
    try {
      const { rows } = await query<PositionRow>(
        `SELECT * FROM positions WHERE device_id = $1 AND valid = TRUE
         ORDER BY fix_time DESC LIMIT 1`,
        [deviceId],
      );
      return rows[0] || null;
    } catch (err) {
      console.error('PositionRepository.findLatestByDevice:', (err as Error).message);
      throw err;
    }
  }

  async findLatestPerDevice(): Promise<PositionRow[]> {
    try {
      const { rows } = await query<PositionRow>(
        `SELECT DISTINCT ON (device_id) *
         FROM positions
         WHERE valid = TRUE
         ORDER BY device_id, fix_time DESC`,
      );
      return rows;
    } catch (err) {
      console.error('PositionRepository.findLatestPerDevice:', (err as Error).message);
      throw err;
    }
  }

  async findHistory({
    deviceId,
    from,
    to,
    limit = 5000,
  }: {
    deviceId: string;
    from: Date | string;
    to: Date | string;
    limit?: number;
  }): Promise<PositionRow[]> {
    try {
      const { rows } = await query<PositionRow>(
        `SELECT * FROM positions
         WHERE device_id = $1 AND fix_time BETWEEN $2 AND $3 AND valid = TRUE
         ORDER BY fix_time ASC
         LIMIT $4`,
        [deviceId, from, to, limit],
      );
      return rows;
    } catch (err) {
      console.error('PositionRepository.findHistory:', (err as Error).message);
      throw err;
    }
  }
}

export default PositionRepository;
