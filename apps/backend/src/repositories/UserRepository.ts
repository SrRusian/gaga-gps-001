import { pool, query } from '../config/database';

export type UserRole = string;

export interface UserRow {
  id: number;
  email: string;
  password: string;
  name: string;
  role: UserRole;
  project_id: number | null;
  active: boolean;
  created_at: Date;
}

export type PublicUserRow = Omit<UserRow, 'password'>;

export class UserHasSessionsError extends Error {
  code = 'USER_HAS_SESSIONS';

  constructor(email: string | number) {
    super(
      `El usuario ${email} tiene turnos de operador registrados - considere desactivarlo en vez de eliminarlo, o elimine con force=true si de verdad desea perder ese historial`,
    );
  }
}

export class EmailAlreadyExistsError extends Error {
  code = 'EMAIL_ALREADY_EXISTS';

  constructor(email: string) {
    super(`Ya existe un usuario con el email ${email}`);
  }
}

class UserRepository {
  async findByEmail(email: string): Promise<UserRow | null> {
    try {
      const { rows } = await query<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
      return rows[0] || null;
    } catch (err) {
      console.error('UserRepository.findByEmail:', (err as Error).message);
      throw err;
    }
  }

  async findById(id: number): Promise<UserRow | null> {
    try {
      const { rows } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
      return rows[0] || null;
    } catch (err) {
      console.error('UserRepository.findById:', (err as Error).message);
      throw err;
    }
  }

  async findAll(): Promise<PublicUserRow[]> {
    try {
      const { rows } = await query<PublicUserRow>(
        'SELECT id, email, name, role, project_id, active, created_at FROM users ORDER BY name ASC',
      );
      return rows;
    } catch (err) {
      console.error('UserRepository.findAll:', (err as Error).message);
      throw err;
    }
  }

  async findByProject(projectId: number): Promise<PublicUserRow[]> {
    try {
      const { rows } = await query<PublicUserRow>(
        'SELECT id, email, name, role, project_id, active, created_at FROM users WHERE project_id = $1 ORDER BY name ASC',
        [projectId],
      );
      return rows;
    } catch (err) {
      console.error('UserRepository.findByProject:', (err as Error).message);
      throw err;
    }
  }

  async create({
    email,
    passwordHash,
    name,
    role = 'operator',
    projectId = null,
  }: {
    email: string;
    passwordHash: string;
    name: string;
    role?: UserRole;
    projectId?: number | null;
  }): Promise<PublicUserRow> {
    try {
      const { rows } = await query<PublicUserRow>(
        `INSERT INTO users (email, password, name, role, project_id)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, email, name, role, project_id, active, created_at`,
        [email, passwordHash, name, role, projectId],
      );
      return rows[0];
    } catch (err) {
      console.error('UserRepository.create:', (err as Error).message);
      throw err;
    }
  }

  async update(
    id: number,
    {
      email,
      name,
      role,
      active,
      projectId,
    }: {
      email?: string;
      name?: string;
      role?: UserRole;
      active?: boolean;
      projectId?: number | null;
    },
  ): Promise<PublicUserRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    if (email !== undefined) {
      values.push(email);
      sets.push(`email = $${values.length}`);
    }
    if (name !== undefined) {
      values.push(name);
      sets.push(`name = $${values.length}`);
    }
    if (role !== undefined) {
      values.push(role);
      sets.push(`role = $${values.length}`);
    }
    if (active !== undefined) {
      values.push(active);
      sets.push(`active = $${values.length}`);
    }
    if (projectId !== undefined) {
      values.push(projectId);
      sets.push(`project_id = $${values.length}`);
    }
    if (sets.length === 0) {
      const { rows } = await query<PublicUserRow>(
        'SELECT id, email, name, role, project_id, active, created_at FROM users WHERE id = $1',
        [id],
      );
      return rows[0] || null;
    }

    try {
      const { rows } = await query<PublicUserRow>(
        `UPDATE users SET ${sets.join(', ')}
         WHERE id = $1
         RETURNING id, email, name, role, project_id, active, created_at`,
        values,
      );
      return rows[0] || null;
    } catch (err) {
      if ((err as { code?: string }).code === '23505' && email) {
        throw new EmailAlreadyExistsError(email);
      }
      console.error('UserRepository.update:', (err as Error).message);
      throw err;
    }
  }

  async countActiveAdmins(excludeId?: number): Promise<number> {
    try {
      const { rows } = await query<{ count: string }>(
        `SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = true AND id != $1`,
        [excludeId ?? -1],
      );
      return Number(rows[0].count);
    } catch (err) {
      console.error('UserRepository.countActiveAdmins:', (err as Error).message);
      throw err;
    }
  }

  async updatePassword(id: number, passwordHash: string): Promise<void> {
    try {
      await query('UPDATE users SET password = $2 WHERE id = $1', [id, passwordHash]);
    } catch (err) {
      console.error('UserRepository.updatePassword:', (err as Error).message);
      throw err;
    }
  }

  /**
   * @param force - si es true, purga también sus turnos de operador
   */
  async delete(id: number, { force = false }: { force?: boolean } = {}): Promise<true> {
    const client = force ? await pool.connect() : null;
    try {
      if (force && client) {
        await client.query('BEGIN');
        await client.query('UPDATE shifts SET supervisor_user_id = NULL WHERE supervisor_user_id = $1', [id]);
        await client.query(
          'UPDATE incident_reports SET reported_by = NULL WHERE reported_by = $1',
          [id],
        );
        await client.query(
          'UPDATE incident_reports SET resolved_by = NULL WHERE resolved_by = $1',
          [id],
        );
        await client.query('DELETE FROM operator_sessions WHERE user_id = $1', [id]);
        await client.query('DELETE FROM users WHERE id = $1', [id]);
        await client.query('COMMIT');
      } else {
        await query('DELETE FROM users WHERE id = $1', [id]);
      }
      return true;
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});

      if ((err as { code?: string }).code === '23503') {
        const user = await this.findById(id);
        throw new UserHasSessionsError(user ? user.email : id);
      }

      console.error('UserRepository.delete:', (err as Error).message);
      throw err;
    } finally {
      if (client) client.release();
    }
  }
}

export default UserRepository;
