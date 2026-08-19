import { haversineDistance } from '../../utils/geometry';
import type IncidentReportRepository from '../../repositories/IncidentReportRepository';
import type { IncidentCategory, IncidentReportRow } from '../../repositories/IncidentReportRepository';

interface SocketServerLike {
  broadcastToProject(projectId: number | null, event: string, payload: unknown): void;
}

interface AlertEventRepoLike {
  recordIncident(event: {
    projectId: number;
    deviceId: string;
    message: string | null;
    incidentId: number;
    category: string;
  }): Promise<unknown>;
  resolveIncident(incidentId: number): Promise<unknown>;
}

interface EvaluatedPosition {
  deviceId: string;
  latitude: number;
  longitude: number;
  projectId?: number | null;
}

export function toPublicShape(incident: IncidentReportRow) {
  return {
    id: Number(incident.id),
    deviceId: incident.device_id,
    category: incident.category,
    message: incident.message,
    latitude: incident.latitude,
    longitude: incident.longitude,
    radiusMeters: incident.radius_meters,
    reportedAt: incident.reported_at,
  };
}

const CATEGORY_LABEL: Record<IncidentCategory, string> = {
  obstacle: 'Objeto en el camino',
  accident: 'Accidente',
  traffic: 'Tráfico/bloqueo',
  other: 'Peligro reportado',
};

class IncidentAlertService {
  socketServer: SocketServerLike;
  incidentRepo: IncidentReportRepository;
  alertEventRepo?: AlertEventRepoLike;
  activeIncidents: Record<number, IncidentReportRow>;
  nearbyNotified: Set<string>;

  constructor({
    socketServer,
    incidentRepo,
    alertEventRepo,
  }: {
    socketServer: SocketServerLike;
    incidentRepo: IncidentReportRepository;
    alertEventRepo?: AlertEventRepoLike;
  }) {
    this.socketServer = socketServer;
    this.incidentRepo = incidentRepo;
    this.alertEventRepo = alertEventRepo;
    this.activeIncidents = {};
    this.nearbyNotified = new Set();
  }

  async hydrate(): Promise<void> {
    const rows = await this.incidentRepo.findAllOpen();
    rows.forEach((row) => {
      this.activeIncidents[row.id] = row;
    });
  }

  async report(params: {
    projectId: number;
    deviceId: string;
    reportedBy: number | null;
    category: IncidentCategory;
    message?: string | null;
    latitude: number;
    longitude: number;
    radiusMeters?: number;
  }): Promise<IncidentReportRow> {
    const incident = await this.incidentRepo.create(params);
    this.activeIncidents[incident.id] = incident;

    const payload = toPublicShape(incident);
    this.socketServer.broadcastToProject(incident.project_id, 'incident:reported', payload);
    this.socketServer.broadcastToProject(incident.project_id, 'supervisor:incident', {
      ...payload,
      level: 1,
    });

    this.alertEventRepo
      ?.recordIncident({
        projectId: incident.project_id,
        deviceId: incident.device_id,
        message: incident.message,
        incidentId: Number(incident.id),
        category: incident.category,
      })
      .catch((err: Error) => console.error('IncidentAlertService.report - alertEventRepo:', err.message));

    return incident;
  }

  async resolve(incidentId: number, resolvedBy: number | null): Promise<IncidentReportRow | null> {
    const incident = this.activeIncidents[incidentId];
    const updated = await this.incidentRepo.resolve(incidentId, resolvedBy);
    if (!updated) return null;

    delete this.activeIncidents[incidentId];
    for (const key of this.nearbyNotified) {
      if (key.startsWith(`${incidentId}:`)) this.nearbyNotified.delete(key);
    }

    const projectId = incident?.project_id ?? updated.project_id;
    this.socketServer.broadcastToProject(projectId, 'incident:resolved', { id: incidentId });
    this.socketServer.broadcastToProject(projectId, 'supervisor:incident', {
      id: incidentId,
      level: 0,
    });

    this.alertEventRepo
      ?.resolveIncident(incidentId)
      .catch((err: Error) => console.error('IncidentAlertService.resolve - alertEventRepo:', err.message));

    return updated;
  }

  async resolveDeviceIncidents(deviceId: string): Promise<void> {
    const ids = Object.values(this.activeIncidents)
      .filter((incident) => incident.device_id === deviceId)
      .map((incident) => incident.id);
    for (const id of ids) {
      await this.resolve(id, null);
    }
  }

  evaluate(position: EvaluatedPosition): void {
    Object.values(this.activeIncidents).forEach((incident) => {
      if (incident.project_id !== position.projectId) return;
      if (incident.device_id === position.deviceId) return;

      const key = `${incident.id}:${position.deviceId}`;
      const distance = haversineDistance(
        position.latitude,
        position.longitude,
        incident.latitude,
        incident.longitude,
      );
      const isNear = distance <= incident.radius_meters;

      if (isNear && !this.nearbyNotified.has(key)) {
        this.nearbyNotified.add(key);
        this.socketServer.broadcastToProject(incident.project_id, 'incident:nearby', {
          deviceId: position.deviceId,
          incidentId: Number(incident.id),
          category: incident.category,
          distance: Math.round(distance),
          message: `${CATEGORY_LABEL[incident.category]} A ${Math.round(distance)}M - PRECAUCIÓN`,
        });
      } else if (!isNear && this.nearbyNotified.has(key)) {
        this.nearbyNotified.delete(key);
      }
    });
  }
}

export default IncidentAlertService;
