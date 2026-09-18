import { pool, query } from '../config/database';

export interface DeviceRow {
  id: number;
  unique_id: string;
  name: string;
  type: string;
  status: string;
  project_id: number | null;
  group_id: number | null;
  vehicle_type_id: number | null;
  attributes: Record<string, unknown>;
  speed_limit_kmh: number | null;
  restricted_to_allowed_zone: boolean;
  last_update: Date | null;
  created_at: Date;
  // solo presentes en findAll/findByProject/findById (LEFT JOIN vehicle_types) - null si el
  // dispositivo no tiene tipo asignado, undefined nunca (siempre se seleccionan las 3 columnas)
  vehicle_type_name?: string | null;
  vehicle_type_length_meters?: number | null;
  vehicle_type_width_meters?: number | null;
}

const SELECT_WITH_VEHICLE_TYPE = `
  SELECT d.*, vt.name AS vehicle_type_name, vt.length_meters AS vehicle_type_length_meters,
    vt.width_meters AS vehicle_type_width_meters
  FROM devices d
  LEFT JOIN vehicle_types vt ON vt.id = d.vehicle_type_id
`;

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

  // mezcla claves nuevas en attributes (JSONB) sin pisar el resto - a diferencia de update(), que
  // reemplaza attributes completo. Usado por report-version (ver app-update.routes.ts) para no
  // borrar otros datos de attributes que el dispositivo ya tuviera guardados
  async mergeAttributes(uniqueId: string, patch: Record<string, unknown>): Promise<DeviceRow | null> {
    try {
      const { rows } = await query<DeviceRow>(
        'UPDATE devices SET attributes = attributes || $2::jsonb WHERE unique_id = $1 RETURNING *',
        [uniqueId, JSON.stringify(patch)],
      );
      return rows[0] || null;
    } catch (err) {
      console.error('DeviceRepository.mergeAttributes:', (err as Error).message);
      throw err;
    }
  }

  async findById(id: number): Promise<DeviceRow | null> {
    try {
      const { rows } = await query<DeviceRow>(`${SELECT_WITH_VEHICLE_TYPE} WHERE d.id = $1`, [id]);
      return rows[0] || null;
    } catch (err) {
      console.error('DeviceRepository.findById:', (err as Error).message);
      throw err;
    }
  }

  async findAll(): Promise<DeviceRow[]> {
    try {
      const { rows } = await query<DeviceRow>(`${SELECT_WITH_VEHICLE_TYPE} ORDER BY d.name ASC`);
      return rows;
    } catch (err) {
      console.error('DeviceRepository.findAll:', (err as Error).message);
      throw err;
    }
  }

  async findByProject(projectId: number): Promise<DeviceRow[]> {
    try {
      const { rows } = await query<DeviceRow>(
        `${SELECT_WITH_VEHICLE_TYPE} WHERE d.project_id = $1 ORDER BY d.name ASC`,
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
    vehicleTypeId = null,
    attributes = {},
  }: {
    uniqueId: string;
    name: string;
    type?: string;
    projectId?: number | null;
    vehicleTypeId?: number | null;
    attributes?: Record<string, unknown>;
  }): Promise<DeviceRow> {
    try {
      const { rows } = await query<DeviceRow>(
        `INSERT INTO devices (unique_id, name, type, project_id, vehicle_type_id, attributes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [uniqueId, name, type, projectId, vehicleTypeId, attributes],
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
      vehicleTypeId,
      attributes,
      speedLimitKmh,
      restrictedToAllowedZone,
    }: {
      name?: string;
      type?: string;
      projectId?: number | null;
      groupId?: number | null;
      vehicleTypeId?: number | null;
      attributes?: Record<string, unknown>;
      speedLimitKmh?: number | null;
      restrictedToAllowedZone?: boolean;
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
    if (vehicleTypeId !== undefined) {
      values.push(vehicleTypeId);
      sets.push(`vehicle_type_id = $${values.length}`);
    }
    if (attributes !== undefined) {
      values.push(attributes);
      sets.push(`attributes = $${values.length}`);
    }
    if (speedLimitKmh !== undefined) {
      values.push(speedLimitKmh);
      sets.push(`speed_limit_kmh = $${values.length}`);
    }
    if (restrictedToAllowedZone !== undefined) {
      values.push(restrictedToAllowedZone);
      sets.push(`restricted_to_allowed_zone = $${values.length}`);
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

  // limite propio del dispositivo + el de su grupo + el de su tipo de vehiculo (si tiene alguno) -
  // SpeedAlertService combina los 3 con el de la geocerca/ruta y se queda con el mas estricto.
  // De paso trae largo/ancho reales del tipo de vehiculo (PositionProcessor los usa para construir
  // el rectangulo orientado de deteccion de proximidad a geocercas peligrosas) - un solo query cubre
  // las dos necesidades, mismo patron ya usado para vehicle_type_name en SELECT_WITH_VEHICLE_TYPE
  async findAlertContext(uniqueId: string): Promise<{
    deviceLimit: number | null;
    groupLimit: number | null;
    vehicleTypeLimit: number | null;
    lengthMeters: number | null;
    widthMeters: number | null;
    restrictedToAllowedZone: boolean;
  }> {
    try {
      const { rows } = await query<{
        device_limit: number | null;
        group_limit: number | null;
        vehicle_type_limit: number | null;
        length_meters: number | null;
        width_meters: number | null;
        restricted_to_allowed_zone: boolean;
      }>(
        `SELECT d.speed_limit_kmh AS device_limit, g.speed_limit_kmh AS group_limit,
                vt.max_speed_kmh AS vehicle_type_limit, vt.length_meters, vt.width_meters,
                d.restricted_to_allowed_zone
         FROM devices d
         LEFT JOIN device_groups g ON g.id = d.group_id
         LEFT JOIN vehicle_types vt ON vt.id = d.vehicle_type_id
         WHERE d.unique_id = $1`,
        [uniqueId],
      );
      if (!rows[0]) {
        return {
          deviceLimit: null,
          groupLimit: null,
          vehicleTypeLimit: null,
          lengthMeters: null,
          widthMeters: null,
          restrictedToAllowedZone: false,
        };
      }
      return {
        deviceLimit: rows[0].device_limit,
        groupLimit: rows[0].group_limit,
        vehicleTypeLimit: rows[0].vehicle_type_limit,
        lengthMeters: rows[0].length_meters,
        widthMeters: rows[0].width_meters,
        restrictedToAllowedZone: rows[0].restricted_to_allowed_zone,
      };
    } catch (err) {
      console.error('DeviceRepository.findAlertContext:', (err as Error).message);
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
          // equipment_activity_segments.operator_session_id / infractions.operator_session_id
          // REFERENCES operator_sessions(id) sin cascade - deben purgarse ANTES de borrar
          // operator_sessions, si no 23503
          await client.query('DELETE FROM equipment_activity_segments WHERE device_id = $1', [uniqueId]);
          await client.query('DELETE FROM infractions WHERE device_id = $1 OR device_id_2 = $1', [uniqueId]);
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
