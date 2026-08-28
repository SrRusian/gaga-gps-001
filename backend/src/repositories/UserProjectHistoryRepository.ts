import { pool, query } from '../config/database';

export interface UserProjectHistoryRow {
  id: number;
  user_id: number;
  project_id: number | null;
  valid_from: Date;
  valid_to: Date | null;
  changed_by: number | null;
}

class UserProjectHistoryRepository {
  async recordChange({
    userId,
    projectId,
    changedBy = null,
  }: {
    userId: number;
    projectId: number | null;
    changedBy?: number | null;
  }): Promise<UserProjectHistoryRow> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE user_project_history SET valid_to = NOW() WHERE user_id = $1 AND valid_to IS NULL`,
        [userId],
      );
      const { rows } = await client.query<UserProjectHistoryRow>(
        `INSERT INTO user_project_history (user_id, project_id, changed_by)
         VALUES ($1, $2, $3) RETURNING *`,
        [userId, projectId, changedBy],
      );
      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('UserProjectHistoryRepository.recordChange:', (err as Error).message);
      throw err;
    } finally {
      client.release();
    }
  }

  async findByUser(userId: number): Promise<UserProjectHistoryRow[]> {
    try {
      const { rows } = await query<UserProjectHistoryRow>(
        `SELECT * FROM user_project_history WHERE user_id = $1 ORDER BY valid_from DESC`,
        [userId],
      );
      return rows;
    } catch (err) {
      console.error('UserProjectHistoryRepository.findByUser:', (err as Error).message);
      throw err;
    }
  }
}

export default UserProjectHistoryRepository;
