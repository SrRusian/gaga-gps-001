import { query } from '../config/database';

export interface VehicleTypeRow {
  id: number;
  name: string;
  length_meters: number;
  width_meters: number;
  max_speed_kmh: number | null;
  // decide comportamientos reales, no es una etiqueta - ver 001_init.sql
  category: 'transport' | 'machinery';
  created_at: Date;
}

class VehicleTypeRepository {
  async findAll(): Promise<VehicleTypeRow[]> {
    try {
      const { rows } = await query<VehicleTypeRow>('SELECT * FROM vehicle_types ORDER BY name ASC');
      return rows;
    } catch (err) {
      console.error('VehicleTypeRepository.findAll:', (err as Error).message);
      throw err;
    }
  }

  async findById(id: number): Promise<VehicleTypeRow | null> {
    try {
      const { rows } = await query<VehicleTypeRow>('SELECT * FROM vehicle_types WHERE id = $1', [id]);
      return rows[0] || null;
    } catch (err) {
      console.error('VehicleTypeRepository.findById:', (err as Error).message);
      throw err;
    }
  }

  async create({
    name,
    lengthMeters,
    widthMeters,
    maxSpeedKmh,
    category,
  }: {
    name: string;
    lengthMeters: number;
    widthMeters: number;
    maxSpeedKmh?: number | null;
    category?: 'transport' | 'machinery';
  }): Promise<VehicleTypeRow> {
    try {
      const { rows } = await query<VehicleTypeRow>(
        `INSERT INTO vehicle_types (name, length_meters, width_meters, max_speed_kmh, category)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, lengthMeters, widthMeters, maxSpeedKmh ?? null, category ?? 'transport'],
      );
      return rows[0];
    } catch (err) {
      console.error('VehicleTypeRepository.create:', (err as Error).message);
      throw err;
    }
  }

  async update(
    id: number,
    {
      name,
      lengthMeters,
      widthMeters,
      maxSpeedKmh,
      category,
    }: {
      name?: string;
      lengthMeters?: number;
      widthMeters?: number;
      maxSpeedKmh?: number | null;
      category?: 'transport' | 'machinery';
    },
  ): Promise<VehicleTypeRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    if (name !== undefined) {
      values.push(name);
      sets.push(`name = $${values.length}`);
    }
    if (lengthMeters !== undefined) {
      values.push(lengthMeters);
      sets.push(`length_meters = $${values.length}`);
    }
    if (widthMeters !== undefined) {
      values.push(widthMeters);
      sets.push(`width_meters = $${values.length}`);
    }
    if (category !== undefined) {
      values.push(category);
      sets.push(`category = $${values.length}`);
    }
    if (maxSpeedKmh !== undefined) {
      values.push(maxSpeedKmh);
      sets.push(`max_speed_kmh = $${values.length}`);
    }
    if (sets.length === 0) return this.findById(id);

    try {
      const { rows } = await query<VehicleTypeRow>(
        `UPDATE vehicle_types SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        values,
      );
      return rows[0] || null;
    } catch (err) {
      console.error('VehicleTypeRepository.update:', (err as Error).message);
      throw err;
    }
  }

  // devices.vehicle_type_id es ON DELETE SET NULL - no hace falta purgar nada aparte, Postgres
  // desvincula solo cualquier dispositivo que usara este tipo
  async delete(id: number): Promise<void> {
    try {
      await query('DELETE FROM vehicle_types WHERE id = $1', [id]);
    } catch (err) {
      console.error('VehicleTypeRepository.delete:', (err as Error).message);
      throw err;
    }
  }
}

export default VehicleTypeRepository;
