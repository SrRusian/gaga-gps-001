import { query } from '../config/database';

export interface AppReleaseRow {
  id: number;
  version_code: number;
  version_name: string;
  sha256: string;
  size_bytes: number;
  released_by: number | null;
  released_at: Date;
  released_by_email: string | null;
}

class AppReleaseRepository {
  async create(params: {
    versionCode: number;
    versionName: string;
    sha256: string;
    sizeBytes: number;
    releasedBy: number | null;
  }): Promise<AppReleaseRow> {
    const { rows } = await query<AppReleaseRow>(
      `INSERT INTO app_releases (version_code, version_name, sha256, size_bytes, released_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *, NULL AS released_by_email`,
      [params.versionCode, params.versionName, params.sha256, params.sizeBytes, params.releasedBy],
    );
    return rows[0];
  }

  async findLatest(): Promise<AppReleaseRow | null> {
    const { rows } = await query<AppReleaseRow>(
      `SELECT r.*, u.email AS released_by_email
       FROM app_releases r
       LEFT JOIN users u ON u.id = r.released_by
       ORDER BY r.version_code DESC
       LIMIT 1`,
    );
    return rows[0] || null;
  }

  async findAll(): Promise<AppReleaseRow[]> {
    const { rows } = await query<AppReleaseRow>(
      `SELECT r.*, u.email AS released_by_email
       FROM app_releases r
       LEFT JOIN users u ON u.id = r.released_by
       ORDER BY r.version_code DESC`,
    );
    return rows;
  }
}

export default AppReleaseRepository;
