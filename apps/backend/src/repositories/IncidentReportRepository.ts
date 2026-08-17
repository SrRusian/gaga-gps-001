/**
 * IncidentReportRepository.ts
 *
 * Responsabilidad: CRUD de reportes de incidente (peligro en el
 * camino) - persistencia; la evaluación en tiempo real (quién está
 * cerca, cuándo alertar) vive en IncidentAlertService.
 */
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

  /** Todos los incidentes abiertos, sin filtrar - usado al arrancar el backend para hidratar IncidentAlertService. */
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
