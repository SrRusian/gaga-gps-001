import { query } from '../config/database';

export interface ProductionRecordRow {
  id: number;
  device_id: string;
  project_id: number | null;
  shift_id: number | null;
  quantity: number;
  unit: string;
  recorded_at: Date;
  recorded_by: number | null;
  metadata: Record<string, unknown>;
}

class ProductionRecordRepository {
  async create({
    deviceId,
    projectId,
    shiftId,
    quantity,
    unit,
    recordedBy,
    metadata,
  }: {
    deviceId: string;
    projectId?: number | null;
    shiftId?: number | null;
    quantity: number;
    unit: string;
    recordedBy?: number | null;
    metadata?: Record<string, unknown>;
  }): Promise<ProductionRecordRow> {
    try {
      const { rows } = await query<ProductionRecordRow>(
        `INSERT INTO production_records (device_id, project_id, shift_id, quantity, unit, recorded_by, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [deviceId, projectId ?? null, shiftId ?? null, quantity, unit, recordedBy ?? null, metadata ?? {}],
      );
      return rows[0];
    } catch (err) {
      console.error('ProductionRecordRepository.create:', (err as Error).message);
      throw err;
    }
  }

  async findByDevice(deviceId: string, from: Date | string, to: Date | string): Promise<ProductionRecordRow[]> {
    try {
      const { rows } = await query<ProductionRecordRow>(
        `SELECT * FROM production_records
         WHERE device_id = $1 AND recorded_at BETWEEN $2 AND $3
         ORDER BY recorded_at ASC`,
        [deviceId, from, to],
      );
      return rows;
    } catch (err) {
      console.error('ProductionRecordRepository.findByDevice:', (err as Error).message);
      throw err;
    }
  }
}

export default ProductionRecordRepository;
