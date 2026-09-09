import { query } from '../config/database';

export type MapStatus = 'processing' | 'ready' | 'failed';

export interface MapBounds {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export interface MapRow {
  id: number;
  name: string;
  project_id: number | null;
  uploaded_by: number | null;
  status: MapStatus;
  source_crs: string | null;
  crs_auto_detected: boolean | null;
  source_image_filename: string | null;
  source_world_filename: string | null;
  bounds: MapBounds | null;
  mbtiles_filename: string | null;
  size_mb: number | null;
  min_zoom: number | null;
  max_zoom: number | null;
  error_message: string | null;
  active: boolean;
  created_at: Date;
}

class MapRepository {
  async findAll(projectId?: number | null): Promise<MapRow[]> {
    try {
      const { rows } =
        projectId != null
          ? await query<MapRow>(
              'SELECT * FROM maps WHERE project_id = $1 ORDER BY created_at DESC',
              [projectId],
            )
          : await query<MapRow>('SELECT * FROM maps ORDER BY created_at DESC');
      return rows;
    } catch (err) {
      console.error('MapRepository.findAll:', (err as Error).message);
      throw err;
    }
  }

  async findById(id: number): Promise<MapRow | null> {
    try {
      const { rows } = await query<MapRow>('SELECT * FROM maps WHERE id = $1', [id]);
      return rows[0] || null;
    } catch (err) {
      console.error('MapRepository.findById:', (err as Error).message);
      throw err;
    }
  }

  async create({
    name,
    projectId,
    uploadedBy,
  }: {
    name: string;
    projectId: number | null;
    uploadedBy?: number | null;
  }): Promise<MapRow> {
    try {
      const { rows } = await query<MapRow>(
        `INSERT INTO maps (name, project_id, uploaded_by) VALUES ($1,$2,$3) RETURNING *`,
        [name, projectId, uploadedBy || null],
      );
      return rows[0];
    } catch (err) {
      console.error('MapRepository.create:', (err as Error).message);
      throw err;
    }
  }

  async setSourceFiles(
    id: number,
    {
      sourceImageFilename,
      sourceWorldFilename,
    }: { sourceImageFilename: string; sourceWorldFilename: string },
  ): Promise<MapRow | null> {
    try {
      const { rows } = await query<MapRow>(
        `UPDATE maps SET source_image_filename = $2, source_world_filename = $3
         WHERE id = $1 RETURNING *`,
        [id, sourceImageFilename, sourceWorldFilename],
      );
      return rows[0] || null;
    } catch (err) {
      console.error('MapRepository.setSourceFiles:', (err as Error).message);
      throw err;
    }
  }

  // SET armado a mano - solo entra projectId cuando de verdad se quiere cambiar (lo decide el
  // caller, ver maps-admin.routes.ts: solo el admin global puede mandarlo)
  async update(
    id: number,
    { name, projectId }: { name?: string; projectId?: number },
  ): Promise<MapRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    if (name !== undefined) {
      values.push(name);
      sets.push(`name = $${values.length}`);
    }
    if (projectId !== undefined) {
      values.push(projectId);
      sets.push(`project_id = $${values.length}`);
    }
    if (sets.length === 0) return this.findById(id);

    try {
      const { rows } = await query<MapRow>(
        `UPDATE maps SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        values,
      );
      return rows[0] || null;
    } catch (err) {
      console.error('MapRepository.update:', (err as Error).message);
      throw err;
    }
  }

  async updateResult(
    id: number,
    {
      status,
      sourceCrs,
      crsAutoDetected,
      bounds,
      mbtilesFilename,
      sizeMb,
      minZoom,
      maxZoom,
      errorMessage,
    }: {
      status: MapStatus;
      sourceCrs?: string;
      crsAutoDetected?: boolean;
      bounds?: MapBounds;
      mbtilesFilename?: string;
      sizeMb?: number;
      minZoom?: number;
      maxZoom?: number;
      errorMessage?: string;
    },
  ): Promise<MapRow | null> {
    try {
      const { rows } = await query<MapRow>(
        `UPDATE maps SET
           status = $2,
           source_crs = COALESCE($3, source_crs),
           crs_auto_detected = COALESCE($4, crs_auto_detected),
           bounds = COALESCE($5, bounds),
           mbtiles_filename = COALESCE($6, mbtiles_filename),
           size_mb = COALESCE($7, size_mb),
           min_zoom = COALESCE($8, min_zoom),
           max_zoom = COALESCE($9, max_zoom),
           error_message = $10
         WHERE id = $1 RETURNING *`,
        [
          id,
          status,
          sourceCrs,
          crsAutoDetected,
          bounds ? JSON.stringify(bounds) : null,
          mbtilesFilename,
          sizeMb,
          minZoom,
          maxZoom,
          errorMessage || null,
        ],
      );
      return rows[0] || null;
    } catch (err) {
      console.error('MapRepository.updateResult:', (err as Error).message);
      throw err;
    }
  }

  async setActive(id: number, active: boolean): Promise<MapRow | null> {
    try {
      const { rows } = await query<MapRow>(
        'UPDATE maps SET active = $2 WHERE id = $1 RETURNING *',
        [id, active],
      );
      return rows[0] || null;
    } catch (err) {
      console.error('MapRepository.setActive:', (err as Error).message);
      throw err;
    }
  }

  async findActiveReady(projectId?: number | null): Promise<MapRow[]> {
    try {
      const { rows } =
        projectId != null
          ? await query<MapRow>(
              `SELECT * FROM maps WHERE active = TRUE AND status = 'ready' AND project_id = $1 ORDER BY created_at ASC`,
              [projectId],
            )
          : await query<MapRow>(
              `SELECT * FROM maps WHERE active = TRUE AND status = 'ready' ORDER BY created_at ASC`,
            );
      return rows;
    } catch (err) {
      console.error('MapRepository.findActiveReady:', (err as Error).message);
      throw err;
    }
  }

  async delete(id: number): Promise<true> {
    try {
      await query('DELETE FROM maps WHERE id = $1', [id]);
      return true;
    } catch (err) {
      console.error('MapRepository.delete:', (err as Error).message);
      throw err;
    }
  }
}

export default MapRepository;
