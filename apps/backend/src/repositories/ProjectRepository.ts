import { pool, query } from '../config/database';

export interface ProjectRow {
  id: number;
  name: string;
  active: boolean;
  created_at: Date;
}

export class ProjectHasDependentsError extends Error {
  code = 'PROJECT_HAS_DEPENDENTS';

  constructor(details: string) {
    super(
      `No se puede eliminar: el proyecto todavía tiene ${details}. Reasígnelos a otro proyecto o elimínelos primero - o desactive el proyecto en vez de eliminarlo.`,
    );
  }
}

class ProjectRepository {
  async findAll(): Promise<ProjectRow[]> {
    try {
      const { rows } = await query<ProjectRow>('SELECT * FROM projects ORDER BY name ASC');
      return rows;
    } catch (err) {
      console.error('ProjectRepository.findAll:', (err as Error).message);
      throw err;
    }
  }

  async findById(id: number): Promise<ProjectRow | null> {
    try {
      const { rows } = await query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [id]);
      return rows[0] || null;
    } catch (err) {
      console.error('ProjectRepository.findById:', (err as Error).message);
      throw err;
    }
  }

  async create({ name }: { name: string }): Promise<ProjectRow> {
    try {
      const { rows } = await query<ProjectRow>(
        'INSERT INTO projects (name) VALUES ($1) RETURNING *',
        [name],
      );
      return rows[0];
    } catch (err) {
      console.error('ProjectRepository.create:', (err as Error).message);
      throw err;
    }
  }

  async update(
    id: number,
    { name, active }: { name?: string; active?: boolean },
  ): Promise<ProjectRow | null> {
    try {
      const { rows } = await query<ProjectRow>(
        `UPDATE projects SET
           name = COALESCE($2, name),
           active = COALESCE($3, active)
         WHERE id = $1 RETURNING *`,
        [id, name, active],
      );
      return rows[0] || null;
    } catch (err) {
      console.error('ProjectRepository.update:', (err as Error).message);
      throw err;
    }
  }

  async delete(id: number): Promise<true> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE users SET project_id = NULL, active = false WHERE project_id = $1',
        [id],
      );
      await client.query('UPDATE devices SET project_id = NULL WHERE project_id = $1', [id]);
      await client.query('DELETE FROM shifts WHERE project_id = $1', [id]);
      await client.query('DELETE FROM geofences WHERE project_id = $1', [id]);
      await client.query('DELETE FROM static_equipment WHERE project_id = $1', [id]);
      await client.query('DELETE FROM incident_reports WHERE project_id = $1', [id]);
      await client.query('DELETE FROM alert_events WHERE project_id = $1', [id]);
      await client.query('DELETE FROM maps WHERE project_id = $1', [id]);
      await client.query('DELETE FROM projects WHERE id = $1', [id]);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});

      if ((err as { code?: string }).code === '23503') {
        throw new ProjectHasDependentsError('datos asociados que este método todavía no cubre');
      }
      console.error('ProjectRepository.delete:', (err as Error).message);
      throw err;
    } finally {
      client.release();
    }
  }
}

export default ProjectRepository;
