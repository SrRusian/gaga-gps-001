import { query } from '../config/database';

export interface DeviceGroupRow {
  id: number;
  project_id: number | null;
  name: string;
  created_at: Date;
}

class DeviceGroupRepository {
  async create({
    projectId,
    name,
  }: {
    projectId: number | null;
    name: string;
  }): Promise<DeviceGroupRow> {
    try {
      const { rows } = await query<DeviceGroupRow>(
        `INSERT INTO device_groups (project_id, name) VALUES ($1, $2) RETURNING *`,
        [projectId, name],
      );
      return rows[0];
    } catch (err) {
      console.error('DeviceGroupRepository.create:', (err as Error).message);
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

  async update(id: number, name: string): Promise<DeviceGroupRow | null> {
    try {
      const { rows } = await query<DeviceGroupRow>(
        `UPDATE device_groups SET name = $2 WHERE id = $1 RETURNING *`,
        [id, name],
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
