import { query } from '../config/database';

export interface EquipmentVariableReadingRow {
  id: number;
  device_id: string;
  variable_key: string;
  value: number;
  unit: string | null;
  recorded_at: Date;
}

export interface EquipmentVariableThresholdRow {
  id: number;
  device_id: string;
  variable_key: string;
  min_safe: number | null;
  max_safe: number | null;
  unit: string | null;
  updated_at: Date;
  updated_by: number | null;
}

class EquipmentVariableRepository {
  async saveReading({
    deviceId,
    variableKey,
    value,
    unit,
  }: {
    deviceId: string;
    variableKey: string;
    value: number;
    unit?: string | null;
  }): Promise<EquipmentVariableReadingRow> {
    try {
      const { rows } = await query<EquipmentVariableReadingRow>(
        `INSERT INTO equipment_variable_readings (device_id, variable_key, value, unit)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [deviceId, variableKey, value, unit ?? null],
      );
      return rows[0];
    } catch (err) {
      console.error('EquipmentVariableRepository.saveReading:', (err as Error).message);
      throw err;
    }
  }

  async findHistory({
    deviceId,
    variableKey,
    from,
    to,
  }: {
    deviceId: string;
    variableKey: string;
    from: Date | string;
    to: Date | string;
  }): Promise<EquipmentVariableReadingRow[]> {
    try {
      const { rows } = await query<EquipmentVariableReadingRow>(
        `SELECT * FROM equipment_variable_readings
         WHERE device_id = $1 AND variable_key = $2 AND recorded_at BETWEEN $3 AND $4
         ORDER BY recorded_at ASC`,
        [deviceId, variableKey, from, to],
      );
      return rows;
    } catch (err) {
      console.error('EquipmentVariableRepository.findHistory:', (err as Error).message);
      throw err;
    }
  }

  async getThreshold(
    deviceId: string,
    variableKey: string,
  ): Promise<EquipmentVariableThresholdRow | null> {
    try {
      const { rows } = await query<EquipmentVariableThresholdRow>(
        `SELECT * FROM equipment_variable_thresholds WHERE device_id = $1 AND variable_key = $2`,
        [deviceId, variableKey],
      );
      return rows[0] || null;
    } catch (err) {
      console.error('EquipmentVariableRepository.getThreshold:', (err as Error).message);
      throw err;
    }
  }

  async setThreshold({
    deviceId,
    variableKey,
    minSafe,
    maxSafe,
    unit,
    updatedBy,
  }: {
    deviceId: string;
    variableKey: string;
    minSafe: number | null;
    maxSafe: number | null;
    unit?: string | null;
    updatedBy: number | null;
  }): Promise<EquipmentVariableThresholdRow> {
    try {
      const { rows } = await query<EquipmentVariableThresholdRow>(
        `INSERT INTO equipment_variable_thresholds (device_id, variable_key, min_safe, max_safe, unit, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (device_id, variable_key)
         DO UPDATE SET min_safe = $3, max_safe = $4, unit = $5, updated_at = NOW(), updated_by = $6
         RETURNING *`,
        [deviceId, variableKey, minSafe, maxSafe, unit ?? null, updatedBy],
      );
      return rows[0];
    } catch (err) {
      console.error('EquipmentVariableRepository.setThreshold:', (err as Error).message);
      throw err;
    }
  }
}

export default EquipmentVariableRepository;
