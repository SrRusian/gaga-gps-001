import { query } from '../config/database';

export type EquipmentStatus = 'active_swing' | 'active_pause' | 'inactive';

export interface EquipmentRow {
  id: number;
  project_id: number | null;
  name: string;
  type: string;
  latitude: number;
  longitude: number;
  swing_radius: number;
  safety_radius: number;
  status: EquipmentStatus;
  linked_device_id: string | null;
}

export class DeviceAlreadyLinkedError extends Error {
  code = 'DEVICE_ALREADY_LINKED';

  constructor(deviceId: string) {
    super(`El dispositivo ${deviceId} ya está vinculado a otro equipo estático`);
  }
}

class EquipmentRepository {
  async findAll(projectId?: number | null): Promise<EquipmentRow[]> {
    try {
      const { rows } =
        projectId != null
          ? await query<EquipmentRow>(
              'SELECT * FROM static_equipment WHERE project_id = $1 ORDER BY id ASC',
              [projectId],
            )
          : await query<EquipmentRow>('SELECT * FROM static_equipment ORDER BY id ASC');
      return rows;
    } catch (err) {
      console.error('EquipmentRepository.findAll:', (err as Error).message);
      throw err;
    }
  }

  async create({
    name,
    projectId,
    type,
    latitude,
    longitude,
    swingRadius,
    safetyRadius,
    status = 'inactive',
    linkedDeviceId = null,
  }: {
    name: string;
    projectId: number | null;
    type: string;
    latitude: number;
    longitude: number;
    swingRadius: number;
    safetyRadius: number;
    status?: EquipmentStatus;
    linkedDeviceId?: string | null;
  }): Promise<EquipmentRow> {
    try {
      const { rows } = await query<EquipmentRow>(
        `INSERT INTO static_equipment
           (name, project_id, type, latitude, longitude, swing_radius, safety_radius, status, linked_device_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [name, projectId, type, latitude, longitude, swingRadius, safetyRadius, status, linkedDeviceId],
      );
      return rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === '23505' && linkedDeviceId) {
        throw new DeviceAlreadyLinkedError(linkedDeviceId);
      }
      console.error('EquipmentRepository.create:', (err as Error).message);
      throw err;
    }
  }

  async update(
    id: number,
    fields: {
      name?: string;
      type?: string;
      latitude?: number;
      longitude?: number;
      swingRadius?: number;
      safetyRadius?: number;
      linkedDeviceId?: string | null;
    },
  ): Promise<EquipmentRow | null> {
    const columns: Record<string, unknown> = {
      name: fields.name,
      type: fields.type,
      latitude: fields.latitude,
      longitude: fields.longitude,
      swing_radius: fields.swingRadius,
      safety_radius: fields.safetyRadius,
      linked_device_id: fields.linkedDeviceId,
    };
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [column, value] of Object.entries(columns)) {
      if (value === undefined) continue;
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length === 0) {
      const { rows } = await query<EquipmentRow>('SELECT * FROM static_equipment WHERE id = $1', [
        id,
      ]);
      return rows[0] || null;
    }
    try {
      const { rows } = await query<EquipmentRow>(
        `UPDATE static_equipment SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        values,
      );
      return rows[0] || null;
    } catch (err) {
      if ((err as { code?: string }).code === '23505' && fields.linkedDeviceId) {
        throw new DeviceAlreadyLinkedError(fields.linkedDeviceId);
      }
      console.error('EquipmentRepository.update:', (err as Error).message);
      throw err;
    }
  }

  async findByLinkedDevice(deviceId: string): Promise<EquipmentRow | null> {
    try {
      const { rows } = await query<EquipmentRow>(
        'SELECT * FROM static_equipment WHERE linked_device_id = $1',
        [deviceId],
      );
      return rows[0] || null;
    } catch (err) {
      console.error('EquipmentRepository.findByLinkedDevice:', (err as Error).message);
      throw err;
    }
  }

  async updateStatus(id: number, status: EquipmentStatus): Promise<EquipmentRow | null> {
    try {
      const { rows } = await query<EquipmentRow>(
        'UPDATE static_equipment SET status = $2 WHERE id = $1 RETURNING *',
        [id, status],
      );
      return rows[0] || null;
    } catch (err) {
      console.error('EquipmentRepository.updateStatus:', (err as Error).message);
      throw err;
    }
  }

  async delete(id: number): Promise<true> {
    try {
      await query('DELETE FROM static_equipment WHERE id = $1', [id]);
      return true;
    } catch (err) {
      console.error('EquipmentRepository.delete:', (err as Error).message);
      throw err;
    }
  }
}

export default EquipmentRepository;
