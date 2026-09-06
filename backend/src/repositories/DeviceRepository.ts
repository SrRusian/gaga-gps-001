import { pool, query } from '../config/database';

export interface DeviceRow {
  id: number;
  unique_id: string;
  name: string;
  type: string;
  status: string;
  project_id: number | null;
  group_id: number | null;
  attributes: Record<string, unknown>;
  speed_limit_kmh: number | null;
  last_update: Date | null;
  created_at: Date;
}

export class DeviceHasPositionsError extends Error {
  code = 'DEVICE_HAS_POSITIONS';

  constructor(uniqueId: string | number) {
    super(
      `El dispositivo ${uniqueId} tiene posiciones y/o turnos de operador registrados - no se puede eliminar sin forzar`,
    );
  }
}

class DeviceRepository {
  async findByUniqueId(uniqueId: string): Promise<DeviceRow | null> {
    try {
      const { rows } = await query<DeviceRow>('SELECT * FROM devices WHERE unique_id = $1', [
        uniqueId,
      ]);
      return rows[0] || null;
    } catch (err) {
      console.error('DeviceRepository.findByUniqueId:', (err as Error).message);
      throw err;
    }
  }

  async findById(id: number): Promise<DeviceRow | null> {
    try {
      const { rows } = await query<DeviceRow>('SELECT * FROM devices WHERE id = $1', [id]);
      return rows[0] || null;
    } catch (err) {
      console.error('DeviceRepository.findById:', (err as Error).message);
      throw err;
    }
  }

  async findAll(): Promise<DeviceRow[]> {
    try {
      const { rows } = await query<DeviceRow>('SELECT * FROM devices ORDER BY name ASC');
      return rows;
    } catch (err) {
      console.error('DeviceRepository.findAll:', (err as Error).message);
      throw err;
    }
  }

  async findByProject(projectId: number): Promise<DeviceRow[]> {
    try {
      const { rows } = await query<DeviceRow>(
        'SELECT * FROM devices WHERE project_id = $1 ORDER BY name ASC',
        [projectId],
      );
      return rows;
    } catch (err) {
      console.error('DeviceRepository.findByProject:', (err as Error).message);
      throw err;
    }
  }

  async findOrCreate(
    uniqueId: string,
    defaults: { name?: string; type?: string } = {},
  ): Promise<DeviceRow> {
    try {
      const existing = await this.findByUniqueId(uniqueId);
      if (existing) return existing;

      const { rows } = await query<DeviceRow>(
        `INSERT INTO devices (unique_id, name, type, status)
         VALUES ($1, $2, $3, 'offline')
         ON CONFLICT (unique_id) DO UPDATE SET unique_id = EXCLUDED.unique_id
         RETURNING *`,
        [uniqueId, defaults.name || uniqueId, defaults.type || 'vehicle'],
      );
      console.log(`Dispositivo auto-registrado: ${uniqueId}`);
      return rows[0];
    } catch (err) {
      console.error('DeviceRepository.findOrCreate:', (err as Error).message);
      throw err;
    }
  }

  async create({
    uniqueId,
    name,
    type = 'vehicle',
    projectId = null,
    attributes = {},
  }: {
    uniqueId: string;
    name: string;
    type?: string;
    projectId?: number | null;
    attributes?: Record<string, unknown>;
  }): Promise<DeviceRow> {
    try {
      const { rows } = await query<DeviceRow>(
        `INSERT INTO devices (unique_id, name, type, project_id, attributes)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [uniqueId, name, type, projectId, attributes],
      );
      return rows[0];
    } catch (err) {
      console.error('DeviceRepository.create:', (err as Error).message);
      throw err;
    }
  }

  async update(
    id: number,
    {
      name,
      type,
      projectId,
      groupId,
      attributes,
      speedLimitKmh,
    }: {
      name?: string;
      type?: string;
      projectId?: number | null;
      groupId?: number | null;
      attributes?: Record<string, unknown>;
      speedLimitKmh?: number | null;
    },
  ): Promise<DeviceRow | null> {
    // SET armado a mano - COALESCE no distingue null intencional de "no vino en el body"
    const sets: string[] = [];
    const values: unknown[] = [id];
    if (name !== undefined) {
      values.push(name);
      sets.push(`name = $${values.length}`);
    }
    if (type !== undefined) {
      values.push(type);
      sets.push(`type = $${values.length}`);
    }
    if (projectId !== undefined) {
      values.push(projectId);
      sets.push(`project_id = $${values.length}`);
    }
    if (groupId !== undefined) {
      values.push(groupId);
      sets.push(`group_id = $${values.length}`);
    }
    if (attributes !== undefined) {
      values.push(attributes);
      sets.push(`attributes = $${values.length}`);
    }
    if (speedLimitKmh !== undefined) {
      values.push(speedLimitKmh);
      sets.push(`speed_limit_kmh = $${values.length}`);
    }
    if (sets.length === 0) return this.findById(id);

    try {
      const { rows } = await query<DeviceRow>(
        `UPDATE devices SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        values,
      );
      return rows[0] || null;
    } catch (err) {
      console.error('DeviceRepository.update:', (err as Error).message);
      throw err;
    }
  }

  // limite propio del dispositivo + el de su grupo (si tiene) - SpeedAlertService combina ambos con
  // el de la geocerca/ruta y se queda con el mas estricto
  async findSpeedLimits(
    uniqueId: string,
  ): Promise<{ deviceLimit: number | null; groupLimit: number | null }> {
    try {
      const { rows } = await query<{ device_limit: number | null; group_limit: number | null }>(
        `SELECT d.speed_limit_kmh AS device_limit, g.speed_limit_kmh AS group_limit
         FROM devices d
         LEFT JOIN device_groups g ON g.id = d.group_id
         WHERE d.unique_id = $1`,
        [uniqueId],
      );
      if (!rows[0]) return { deviceLimit: null, groupLimit: null };
      return { deviceLimit: rows[0].device_limit, groupLimit: rows[0].group_limit };
    } catch (err) {
      console.error('DeviceRepository.findSpeedLimits:', (err as Error).message);
      throw err;
    }
  }

  async updateStatus(
    uniqueId: string,
    status: string,
    lastUpdate: Date = new Date(),
  ): Promise<void> {
    try {
      await query('UPDATE devices SET status = $2, last_update = $3 WHERE unique_id = $1', [
        uniqueId,
        status,
        lastUpdate,
      ]);
    } catch (err) {
      console.error('DeviceRepository.updateStatus:', (err as Error).message);
      throw err;
    }
  }

  // force=true purga todo el historial antes de eliminar
  async delete(id: number, { force = false }: { force?: boolean } = {}): Promise<true> {
    const client = force ? await pool.connect() : null;
    try {
      if (force && client) {
        await client.query('BEGIN');
        const { rows } = await client.query<{ unique_id: string }>(
          'SELECT unique_id FROM devices WHERE id = $1',
          [id],
        );
        const uniqueId = rows[0]?.unique_id;
        if (uniqueId) {
          // debe purgar TODAS las FK reales a devices - grep REFERENCES devices en 001_init.sql
          // equipment_activity_segments.operator_session_id REFERENCES operator_sessions(id) sin
          // cascade - debe purgarse ANTES de borrar operator_sessions, si no 23503
          await client.query('DELETE FROM equipment_activity_segments WHERE device_id = $1', [uniqueId]);
          await client.query('DELETE FROM operator_sessions WHERE device_id = $1', [uniqueId]);
          await client.query('DELETE FROM positions WHERE device_id = $1', [uniqueId]);
          await client.query('DELETE FROM device_sensor_snapshots WHERE device_id = $1', [uniqueId]);
          await client.query('DELETE FROM geofence_events WHERE device_id = $1', [uniqueId]);
          await client.query('DELETE FROM incident_reports WHERE device_id = $1', [uniqueId]);
          await client.query('DELETE FROM device_project_history WHERE device_id = $1', [uniqueId]);
          await client.query('DELETE FROM equipment_variable_readings WHERE device_id = $1', [uniqueId]);
          await client.query('DELETE FROM equipment_variable_thresholds WHERE device_id = $1', [uniqueId]);
          await client.query('DELETE FROM production_records WHERE device_id = $1', [uniqueId]);
          await client.query('DELETE FROM pay_rates WHERE device_id = $1', [uniqueId]);
          await client.query(
            'DELETE FROM alert_events WHERE device_id = $1 OR device_id_2 = $1',
            [uniqueId],
          );
        }
        await client.query('DELETE FROM devices WHERE id = $1', [id]);
        await client.query('COMMIT');
      } else {
        await query('DELETE FROM devices WHERE id = $1', [id]);
      }
      return true;
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});

      if ((err as { code?: string }).code === '23503') {
        const device = await this.findById(id);
        throw new DeviceHasPositionsError(device ? device.unique_id : id);
      }

      console.error('DeviceRepository.delete:', (err as Error).message);
      throw err;
    } finally {
      if (client) client.release();
    }
  }
}

export default DeviceRepository;
