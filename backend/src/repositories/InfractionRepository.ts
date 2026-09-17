import { query } from '../config/database';

export type InfractionType = 'speed' | 'geofence';

export interface InfractionRow {
  id: number;
  project_id: number | null;
  device_id: string;
  operator_session_id: number | null;
  infraction_type: InfractionType;
  message: string;
  latitude: number;
  longitude: number;
  metadata: Record<string, unknown> | null;
  occurred_at: Date;
  reviewed_by: number | null;
  reviewed_at: Date | null;
  review_notes: string | null;
}

export interface InfractionWithNamesRow extends InfractionRow {
  device_name: string | null;
  operator_name: string | null;
  reviewed_by_name: string | null;
}

// registro permanente de infracciones reales (velocidad/geocerca) - generado solo por el sistema
// (SpeedAlertService/GeofenceAlertService), nunca creado a mano vía API. A diferencia de
// alert_events, nunca se sobreescribe: una fila por episodio real.
class InfractionRepository {
  async create({
    projectId,
    deviceId,
    infractionType,
    message,
    latitude,
    longitude,
    metadata = null,
  }: {
    projectId: number | null;
    deviceId: string;
    infractionType: InfractionType;
    message: string;
    latitude: number;
    longitude: number;
    metadata?: Record<string, unknown> | null;
  }): Promise<InfractionRow> {
    try {
      const { rows } = await query<InfractionRow>(
        // el turno activo (si hay) se resuelve aqui mismo - evita que cada servicio de alerta tenga
        // que conocer OperatorSessionRepository solo para esto. $8 duplica $2 en vez de reusarlo -
        // reusar el mismo placeholder dentro de un VALUES() y una subconsulta aparte confunde al
        // planner ("inconsistent types deduced for parameter $2", gotcha ya documentado)
        `INSERT INTO infractions
           (project_id, device_id, operator_session_id, infraction_type, message, latitude, longitude, metadata)
         VALUES ($1, $2,
           (SELECT id FROM operator_sessions WHERE device_id = $8 AND ended_at IS NULL LIMIT 1),
           $3, $4, $5, $6, $7)
         RETURNING *`,
        [projectId, deviceId, infractionType, message, latitude, longitude, metadata, deviceId],
      );
      return rows[0];
    } catch (err) {
      console.error('InfractionRepository.create:', (err as Error).message);
      throw err;
    }
  }

  async findByProject(
    projectId: number | null,
    {
      limit = 100,
      offset = 0,
      from,
      to,
    }: { limit?: number; offset?: number; from?: string; to?: string } = {},
  ): Promise<InfractionWithNamesRow[]> {
    try {
      const conditions: string[] = ['($1::int IS NULL OR i.project_id = $1 OR i.project_id IS NULL)'];
      const params: unknown[] = [projectId];

      if (from) {
        params.push(from);
        conditions.push(`i.occurred_at >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        conditions.push(`i.occurred_at <= $${params.length}`);
      }

      params.push(limit);
      params.push(offset);

      const { rows } = await query<InfractionWithNamesRow>(
        `SELECT i.*, d.name AS device_name, u.name AS operator_name, r.name AS reviewed_by_name
         FROM infractions i
         LEFT JOIN devices d ON d.unique_id = i.device_id
         LEFT JOIN operator_sessions s ON s.id = i.operator_session_id
         LEFT JOIN users u ON u.id = s.user_id
         LEFT JOIN users r ON r.id = i.reviewed_by
         WHERE ${conditions.join(' AND ')}
         ORDER BY i.occurred_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return rows;
    } catch (err) {
      console.error('InfractionRepository.findByProject:', (err as Error).message);
      throw err;
    }
  }

  async findById(id: number): Promise<InfractionRow | null> {
    try {
      const { rows } = await query<InfractionRow>('SELECT * FROM infractions WHERE id = $1', [id]);
      return rows[0] || null;
    } catch (err) {
      console.error('InfractionRepository.findById:', (err as Error).message);
      throw err;
    }
  }

  async markReviewed(
    id: number,
    reviewedBy: number | null,
    notes?: string | null,
  ): Promise<InfractionRow | null> {
    try {
      const { rows } = await query<InfractionRow>(
        `UPDATE infractions SET reviewed_by = $2, reviewed_at = NOW(), review_notes = $3
         WHERE id = $1 RETURNING *`,
        [id, reviewedBy, notes ?? null],
      );
      return rows[0] || null;
    } catch (err) {
      console.error('InfractionRepository.markReviewed:', (err as Error).message);
      throw err;
    }
  }
}

export default InfractionRepository;
