/**
 * ShiftRepository.ts
 *
 * Responsabilidad: CRUD de turnos programados (horario recurrente
 * diario por proyecto) - no confundir con operator_sessions (turno
 * operador+vehículo). El Encargado de Proyecto crea/edita estos y
 * asigna un Supervisor de Proyecto a cada uno.
 */
import { query } from '../config/database';

export interface ShiftRow {
  id: number;
  project_id: number;
  name: string;
  start_time: string;
  end_time: string;
  supervisor_user_id: number | null;
  active: boolean;
  created_at: Date;
}

class ShiftRepository {
  async findByProject(projectId: number): Promise<ShiftRow[]> {
    try {
      const { rows } = await query<ShiftRow>(
        'SELECT * FROM shifts WHERE project_id = $1 ORDER BY start_time ASC',
        [projectId],
      );
      return rows;
    } catch (err) {
      console.error('ShiftRepository.findByProject:', (err as Error).message);
      throw err;
    }
  }

  async findActiveByProject(projectId: number): Promise<ShiftRow[]> {
    try {
      const { rows } = await query<ShiftRow>(
        'SELECT * FROM shifts WHERE project_id = $1 AND active = TRUE ORDER BY start_time ASC',
        [projectId],
      );
      return rows;
    } catch (err) {
      console.error('ShiftRepository.findActiveByProject:', (err as Error).message);
      throw err;
    }
  }

  async findById(id: number): Promise<ShiftRow | null> {
    try {
      const { rows } = await query<ShiftRow>('SELECT * FROM shifts WHERE id = $1', [id]);
      return rows[0] || null;
    } catch (err) {
      console.error('ShiftRepository.findById:', (err as Error).message);
      throw err;
    }
  }

  /** Turno(s) donde este usuario es el supervisor asignado. */
  async findBySupervisor(supervisorUserId: number): Promise<ShiftRow[]> {
    try {
      const { rows } = await query<ShiftRow>(
        'SELECT * FROM shifts WHERE supervisor_user_id = $1 AND active = TRUE',
        [supervisorUserId],
      );
      return rows;
    } catch (err) {
      console.error('ShiftRepository.findBySupervisor:', (err as Error).message);
      throw err;
    }
  }

  async create({
    projectId,
    name,
    startTime,
    endTime,
    supervisorUserId = null,
  }: {
    projectId: number;
    name: string;
    startTime: string;
    endTime: string;
    supervisorUserId?: number | null;
  }): Promise<ShiftRow> {
    try {
      const { rows } = await query<ShiftRow>(
        `INSERT INTO shifts (project_id, name, start_time, end_time, supervisor_user_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [projectId, name, startTime, endTime, supervisorUserId],
      );
      return rows[0];
    } catch (err) {
      console.error('ShiftRepository.create:', (err as Error).message);
      throw err;
    }
  }

  async update(
    id: number,
    {
      name,
      startTime,
      endTime,
      supervisorUserId,
      active,
    }: {
      name?: string;
      startTime?: string;
      endTime?: string;
      supervisorUserId?: number | null;
      active?: boolean;
    },
  ): Promise<ShiftRow | null> {
    // COALESCE no distingue "no lo mandaron" (undefined, no tocar) de
    // "lo mandaron como null" (limpiar de verdad, ej. quitar el
    // supervisor asignado) - ambos bindean como NULL en pg. Se arma
    // el SET a mano por eso: solo entra el campo cuya key vino en el
    // body, aunque su valor sea null. (Bug real ya documentado en
    // CLAUDE.md - "no se puede explicitar null vía update" - ahora
    // corregido de verdad en vez de solo anotado.)
    const sets: string[] = [];
    const values: unknown[] = [id];
    if (name !== undefined) {
      values.push(name);
      sets.push(`name = $${values.length}`);
    }
    if (startTime !== undefined) {
      values.push(startTime);
      sets.push(`start_time = $${values.length}`);
    }
    if (endTime !== undefined) {
      values.push(endTime);
      sets.push(`end_time = $${values.length}`);
    }
    if (supervisorUserId !== undefined) {
      values.push(supervisorUserId);
      sets.push(`supervisor_user_id = $${values.length}`);
    }
    if (active !== undefined) {
      values.push(active);
      sets.push(`active = $${values.length}`);
    }
    if (sets.length === 0) return this.findById(id);

    try {
      const { rows } = await query<ShiftRow>(
        `UPDATE shifts SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        values,
      );
      return rows[0] || null;
    } catch (err) {
      console.error('ShiftRepository.update:', (err as Error).message);
      throw err;
    }
  }

  /**
   * `operator_sessions.shift_id` tiene ON DELETE SET NULL - el
   * historial de horas trabajadas bajo este turno se conserva, solo
   * queda sin turno asociado. No hace falta ninguna limpieza manual
   * aparte, a diferencia de otros `delete({force:true})` de este
   * proyecto que sí necesitan purgar/desvincular a mano.
   */
  async delete(id: number): Promise<true> {
    try {
      await query('DELETE FROM shifts WHERE id = $1', [id]);
      return true;
    } catch (err) {
      console.error('ShiftRepository.delete:', (err as Error).message);
      throw err;
    }
  }
}

export default ShiftRepository;
