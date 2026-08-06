/**
 * EquipmentRepository.ts
 *
 * Responsabilidad: CRUD de equipo estático (palas, excavadoras,
 * cargadores) en PostgreSQL.
 */
import { query } from '../config/database';

export type EquipmentStatus = 'active_swing' | 'active_pause' | 'inactive';

export interface EquipmentRow {
  id: number;
  name: string;
  type: string;
  latitude: number;
  longitude: number;
  swing_radius: number;
  safety_radius: number;
  status: EquipmentStatus;
}

class EquipmentRepository {
  async findAll(): Promise<EquipmentRow[]> {
    try {
      const { rows } = await query<EquipmentRow>('SELECT * FROM static_equipment ORDER BY id ASC');
      return rows;
    } catch (err) {
      console.error('❌ EquipmentRepository.findAll:', (err as Error).message);
      throw err;
    }
  }

  async create({
    name,
    type,
    latitude,
    longitude,
    swingRadius,
    safetyRadius,
    status = 'inactive',
  }: {
    name: string;
    type: string;
    latitude: number;
    longitude: number;
    swingRadius: number;
    safetyRadius: number;
    status?: EquipmentStatus;
  }): Promise<EquipmentRow> {
    try {
      const { rows } = await query<EquipmentRow>(
        `INSERT INTO static_equipment
           (name, type, latitude, longitude, swing_radius, safety_radius, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [name, type, latitude, longitude, swingRadius, safetyRadius, status],
      );
      return rows[0];
    } catch (err) {
      console.error('❌ EquipmentRepository.create:', (err as Error).message);
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
      console.error('❌ EquipmentRepository.updateStatus:', (err as Error).message);
      throw err;
    }
  }

  async delete(id: number): Promise<true> {
    try {
      await query('DELETE FROM static_equipment WHERE id = $1', [id]);
      return true;
    } catch (err) {
      console.error('❌ EquipmentRepository.delete:', (err as Error).message);
      throw err;
    }
  }
}

export default EquipmentRepository;
