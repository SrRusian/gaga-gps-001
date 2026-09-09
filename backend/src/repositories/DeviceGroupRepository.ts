import { query } from '../config/database';

export interface DeviceGroupRow {
  id: number;
  project_id: number | null;
  name: string;
  speed_limit_kmh: number | null;
  created_at: Date;
}

class DeviceGroupRepository {
  async create({
    projectId,
    name,
    speedLimitKmh,
  }: {
    projectId: number | null;
    name: string;
    speedLimitKmh?: number | null;
  }): Promise<DeviceGroupRow> {
    try {
      const { rows } = await query<DeviceGroupRow>(
        `INSERT INTO device_groups (project_id, name, speed_limit_kmh) VALUES ($1, $2, $3) RETURNING *`,
        [projectId, name, speedLimitKmh ?? null],
      );
      return rows[0];
    } catch (err) {
      console.error('DeviceGroupRepository.create:', (err as Error).message);
      throw err;
    }
  }

  async findById(id: number): Promise<DeviceGroupRow | null> {
    try {
      const { rows } = await query<DeviceGroupRow>('SELECT * FROM device_groups WHERE id = $1', [
        id,
      ]);
      return rows[0] || null;
    } catch (err) {
      console.error('DeviceGroupRepository.findById:', (err as Error).message);
      throw err;
    }
  }

  async findByProject(projectId: number | null): Promise<DeviceGroupRow[]> {
    try {
      const { rows } =
        projectId != null
          ? await query<DeviceGroupRow>(
              `SELECT * FROM device_groups WHERE project_id = $1 ORDER BY name ASC`,
              [projectId],
            )
          : await query<DeviceGroupRow>(`SELECT * FROM device_groups ORDER BY name ASC`);
      return rows;
    } catch (err) {
      console.error('DeviceGroupRepository.findByProject:', (err as Error).message);
      throw err;
    }
  }

  async update(
    id: number,
    { name, speedLimitKmh }: { name?: string; speedLimitKmh?: number | null },
  ): Promise<DeviceGroupRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    if (name !== undefined) {
      values.push(name);
      sets.push(`name = $${values.length}`);
    }
    if (speedLimitKmh !== undefined) {
      values.push(speedLimitKmh);
      sets.push(`speed_limit_kmh = $${values.length}`);
    }
    if (sets.length === 0) return this.findById(id);

    try {
      const { rows } = await query<DeviceGroupRow>(
        `UPDATE device_groups SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        values,
      );
      return rows[0] || null;
    } catch (err) {
      console.error('DeviceGroupRepository.update:', (err as Error).message);
      throw err;
    }
  }

  async delete(id: number): Promise<void> {
    try {
      await query('DELETE FROM device_groups WHERE id = $1', [id]);
    } catch (err) {
      console.error('DeviceGroupRepository.delete:', (err as Error).message);
      throw err;
    }
  }
}

export default DeviceGroupRepository;
