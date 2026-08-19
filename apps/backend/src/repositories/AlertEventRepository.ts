import { query } from '../config/database';

export type AlertType =
  | 'geofence'
  | 'signal_lost'
  | 'collision'
  | 'proximity'
  | 'preventive_stop'
  | 'incident';

export type AlertSeverity = 'info' | 'warning' | 'danger';

export interface AlertEventRow {
  id: number;
  project_id: number | null;
  alert_type: AlertType;
  severity: AlertSeverity;
  device_id: string | null;
  device_id_2: string | null;
  message: string | null;
  metadata: Record<string, unknown> | null;
  triggered_at: Date;
  resolved_at: Date | null;
}

class AlertEventRepository {
  async recordOrEscalate({
    alertType,
    severity,
    deviceId = null,
    deviceId2 = null,
    message = null,
    metadata = null,
    projectId,
  }: {
    alertType: AlertType;
    severity: AlertSeverity;
    deviceId?: string | null;
    deviceId2?: string | null;
    message?: string | null;
    metadata?: Record<string, unknown> | null;
    projectId?: number | null;
  }): Promise<AlertEventRow> {
    try {
      const resolvedProjectId =
        projectId !== undefined ? projectId : await this._resolveProjectId(deviceId);

      const { rows: updated } = await query<AlertEventRow>(
        `UPDATE alert_events SET severity = $4, message = $5, metadata = $6
         WHERE alert_type = $1
           AND device_id IS NOT DISTINCT FROM $2
           AND device_id_2 IS NOT DISTINCT FROM $3
           AND resolved_at IS NULL
         RETURNING *`,
        [alertType, deviceId, deviceId2, severity, message, metadata],
      );
      if (updated[0]) return updated[0];

      const { rows: inserted } = await query<AlertEventRow>(
        `INSERT INTO alert_events (project_id, alert_type, severity, device_id, device_id_2, message, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [resolvedProjectId, alertType, severity, deviceId, deviceId2, message, metadata],
      );
      return inserted[0];
    } catch (err) {
      console.error('AlertEventRepository.recordOrEscalate:', (err as Error).message);
      throw err;
    }
  }

  async resolveOpen({
    alertType,
    deviceId = null,
    deviceId2 = null,
  }: {
    alertType: AlertType;
    deviceId?: string | null;
    deviceId2?: string | null;
  }): Promise<void> {
    try {
      await query(
        `UPDATE alert_events SET resolved_at = NOW()
         WHERE alert_type = $1
           AND device_id IS NOT DISTINCT FROM $2
           AND device_id_2 IS NOT DISTINCT FROM $3
           AND resolved_at IS NULL`,
        [alertType, deviceId, deviceId2],
      );
    } catch (err) {
      console.error('AlertEventRepository.resolveOpen:', (err as Error).message);
      throw err;
    }
  }

  async findActive(projectId: number | null): Promise<AlertEventRow[]> {
    try {
      const { rows } = await query<AlertEventRow>(
        `SELECT * FROM alert_events
         WHERE resolved_at IS NULL
           AND ($1::int IS NULL OR project_id = $1 OR project_id IS NULL)
         ORDER BY triggered_at ASC`,
        [projectId],
      );
      return rows;
    } catch (err) {
      console.error('AlertEventRepository.findActive:', (err as Error).message);
      throw err;
    }
  }

  async findHistory({
    projectId,
    alertType,
    severity,
    deviceId,
    from,
    to,
    limit = 100,
    offset = 0,
  }: {
    projectId: number | null;
    alertType?: AlertType;
    severity?: AlertSeverity;
    deviceId?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<AlertEventRow[]> {
    try {
      const conditions: string[] = ['($1::int IS NULL OR project_id = $1 OR project_id IS NULL)'];
      const params: unknown[] = [projectId];

      if (alertType) {
        params.push(alertType);
        conditions.push(`alert_type = $${params.length}`);
      }
      if (severity) {
        params.push(severity);
        conditions.push(`severity = $${params.length}`);
      }
      if (deviceId) {
        params.push(deviceId);
        conditions.push(`(device_id = $${params.length} OR device_id_2 = $${params.length})`);
      }
      if (from) {
        params.push(from);
        conditions.push(`triggered_at >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        conditions.push(`triggered_at <= $${params.length}`);
      }

      params.push(limit);
      params.push(offset);

      const { rows } = await query<AlertEventRow>(
        `SELECT * FROM alert_events
         WHERE ${conditions.join(' AND ')}
         ORDER BY triggered_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return rows;
    } catch (err) {
      console.error('AlertEventRepository.findHistory:', (err as Error).message);
      throw err;
    }
  }

  async recordIncident({
    projectId,
    deviceId,
    message,
    incidentId,
    category,
  }: {
    projectId: number;
    deviceId: string;
    message: string | null;
    incidentId: number;
    category: string;
  }): Promise<AlertEventRow> {
    try {
      const { rows } = await query<AlertEventRow>(
        `INSERT INTO alert_events (project_id, alert_type, severity, device_id, message, metadata)
         VALUES ($1,'incident','warning',$2,$3,$4) RETURNING *`,
        [projectId, deviceId, message, JSON.stringify({ incidentId, category })],
      );
      return rows[0];
    } catch (err) {
      console.error('AlertEventRepository.recordIncident:', (err as Error).message);
      throw err;
    }
  }

  async resolveIncident(incidentId: number): Promise<void> {
    try {
      await query(
        `UPDATE alert_events SET resolved_at = NOW()
         WHERE alert_type = 'incident'
           AND (metadata->>'incidentId')::bigint = $1
           AND resolved_at IS NULL`,
        [incidentId],
      );
    } catch (err) {
      console.error('AlertEventRepository.resolveIncident:', (err as Error).message);
      throw err;
    }
  }

  async _resolveProjectId(deviceId: string | null): Promise<number | null> {
    if (!deviceId) return null;
    try {
      const { rows } = await query<{ project_id: number | null }>(
        'SELECT project_id FROM devices WHERE unique_id = $1',
        [deviceId],
      );
      return rows[0]?.project_id ?? null;
    } catch (err) {
      console.error('AlertEventRepository._resolveProjectId:', (err as Error).message);
      return null;
    }
  }
}

export default AlertEventRepository;
