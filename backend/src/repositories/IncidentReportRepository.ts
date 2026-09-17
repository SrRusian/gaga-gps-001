import { query } from '../config/database';

export type IncidentCategory = 'obstacle' | 'accident' | 'traffic' | 'other';
export type IncidentStatus = 'open' | 'resolved';

export interface IncidentReportRow {
  id: number;
  project_id: number;
  device_id: string;
  reported_by: number | null;
  category: IncidentCategory;
  message: string | null;
  latitude: number;
  longitude: number;
  radius_meters: number;
  status: IncidentStatus;
  resolved_by: number | null;
  reported_at: Date;
  resolved_at: Date | null;
}

export interface IncidentHistoryRow extends IncidentReportRow {
  device_name: string | null;
  reported_by_name: string | null;
  resolved_by_name: string | null;
}

class IncidentReportRepository {
  async findOpenByProject(projectId: number): Promise<IncidentReportRow[]> {
    try {
      const { rows } = await query<IncidentReportRow>(
        `SELECT * FROM incident_reports WHERE project_id = $1 AND status = 'open' ORDER BY reported_at DESC`,
        [projectId],
      );
      return rows;
    } catch (err) {
      console.error('IncidentReportRepository.findOpenByProject:', (err as Error).message);
      throw err;
    }
  }

  async findAllOpen(): Promise<IncidentReportRow[]> {
    try {
      const { rows } = await query<IncidentReportRow>(
        `SELECT * FROM incident_reports WHERE status = 'open' ORDER BY reported_at DESC`,
      );
      return rows;
    } catch (err) {
      console.error('IncidentReportRepository.findAllOpen:', (err as Error).message);
      throw err;
    }
  }

  // abiertos + resueltos (a diferencia de findOpenByProject/findAllOpen) - para el panel de
  // Supervisor/Encargado ("Incidentes"): Supervisor siempre manda `from` = arranque del dia actual
  // (su "turno"), Encargado puede filtrar libremente por rango - ver infractions.routes.ts para el
  // mismo criterio ya aplicado ahi
  async findHistory(
    projectId: number,
    {
      from,
      to,
      status,
      deviceId,
      reportedByName,
    }: {
      from?: string;
      to?: string;
      status?: IncidentStatus;
      deviceId?: string;
      reportedByName?: string;
    } = {},
  ): Promise<IncidentHistoryRow[]> {
    try {
      const conditions: string[] = ['i.project_id = $1'];
      const params: unknown[] = [projectId];

      if (from) {
        params.push(from);
        conditions.push(`i.reported_at >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        conditions.push(`i.reported_at <= $${params.length}`);
      }
      if (status) {
        params.push(status);
        conditions.push(`i.status = $${params.length}`);
      }
      if (deviceId) {
        params.push(deviceId);
        conditions.push(`i.device_id = $${params.length}`);
      }
      if (reportedByName) {
        params.push(`%${reportedByName}%`);
        conditions.push(`u.name ILIKE $${params.length}`);
      }

      const { rows } = await query<IncidentHistoryRow>(
        `SELECT i.*, d.name AS device_name, u.name AS reported_by_name, r.name AS resolved_by_name
         FROM incident_reports i
         LEFT JOIN devices d ON d.unique_id = i.device_id
         LEFT JOIN users u ON u.id = i.reported_by
         LEFT JOIN users r ON r.id = i.resolved_by
         WHERE ${conditions.join(' AND ')}
         ORDER BY i.reported_at DESC`,
        params,
      );
      return rows;
    } catch (err) {
      console.error('IncidentReportRepository.findHistory:', (err as Error).message);
      throw err;
    }
  }

  async findById(id: number): Promise<IncidentReportRow | null> {
    try {
      const { rows } = await query<IncidentReportRow>(
        'SELECT * FROM incident_reports WHERE id = $1',
        [id],
      );
      return rows[0] || null;
    } catch (err) {
      console.error('IncidentReportRepository.findById:', (err as Error).message);
      throw err;
    }
  }

  async create({
    projectId,
    deviceId,
    reportedBy,
    category,
    message,
    latitude,
    longitude,
    radiusMeters,
  }: {
    projectId: number;
    deviceId: string;
    reportedBy: number | null;
    category: IncidentCategory;
    message?: string | null;
    latitude: number;
    longitude: number;
    radiusMeters?: number;
  }): Promise<IncidentReportRow> {
    try {
      const { rows } = await query<IncidentReportRow>(
        // 120m default - no cambiar sin confirmar con el equipo de campo
        `INSERT INTO incident_reports
           (project_id, device_id, reported_by, category, message, latitude, longitude, radius_meters)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, 120))
         RETURNING *`,
        [projectId, deviceId, reportedBy, category, message ?? null, latitude, longitude, radiusMeters],
      );
      return rows[0];
    } catch (err) {
      console.error('IncidentReportRepository.create:', (err as Error).message);
      throw err;
    }
  }

  async resolve(id: number, resolvedBy: number | null): Promise<IncidentReportRow | null> {
    try {
      const { rows } = await query<IncidentReportRow>(
        `UPDATE incident_reports SET status = 'resolved', resolved_by = $2, resolved_at = NOW()
         WHERE id = $1 AND status = 'open' RETURNING *`,
        [id, resolvedBy],
      );
      return rows[0] || null;
    } catch (err) {
      console.error('IncidentReportRepository.resolve:', (err as Error).message);
      throw err;
    }
  }
}

export default IncidentReportRepository;
