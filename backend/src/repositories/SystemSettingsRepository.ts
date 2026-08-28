import { query } from '../config/database';

export interface SystemSettingRow {
  key: string;
  value: string | null;
  updated_at: Date;
  updated_by: number | null;
}

class SystemSettingsRepository {
  async get(key: string): Promise<string | null> {
    try {
      const { rows } = await query<SystemSettingRow>(
        'SELECT * FROM system_settings WHERE key = $1',
        [key],
      );
      return rows[0]?.value ?? null;
    } catch (err) {
      console.error('SystemSettingsRepository.get:', (err as Error).message);
      throw err;
    }
  }

  async getAll(): Promise<SystemSettingRow[]> {
    try {
      const { rows } = await query<SystemSettingRow>('SELECT * FROM system_settings ORDER BY key ASC');
      return rows;
    } catch (err) {
      console.error('SystemSettingsRepository.getAll:', (err as Error).message);
      throw err;
    }
  }

  async set(key: string, value: string | null, updatedBy: number | null): Promise<SystemSettingRow> {
    try {
      const { rows } = await query<SystemSettingRow>(
        `INSERT INTO system_settings (key, value, updated_at, updated_by)
         VALUES ($1,$2,NOW(),$3)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW(), updated_by = $3
         RETURNING *`,
        [key, value, updatedBy],
      );
      return rows[0];
    } catch (err) {
      console.error('SystemSettingsRepository.set:', (err as Error).message);
      throw err;
    }
  }
}

export default SystemSettingsRepository;
