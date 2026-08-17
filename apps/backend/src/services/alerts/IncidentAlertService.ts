/**
 * IncidentAlertService.ts
 *
 * Responsabilidad: alertas de incidente en tiempo real estilo
 * Waze/Uber - un operador reporta un peligro (objeto en el camino,
 * accidente, tráfico) desde su posición actual; este servicio avisa
 * a quien se acerque (una sola vez mientras siga dentro del radio,
 * no en cada fix) y notifica a Supervisor/Encargado del proyecto.
 *
 * A diferencia de CollisionRiskService/VehicleProximityService/
 * GeofenceAlertService (todavía globales - ver README "Multi-tenencia
 * por proyecto"), este nace ya aislado por proyecto: cada incidente
 * ya trae su `project_id`, así que `evaluate()` solo lo compara
 * contra incidentes del MISMO proyecto que la posición entrante, y
 * emite con `broadcastToProject` en vez de un `io.emit` global.
 */
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
    // BIGSERIAL vuelve como string desde node-postgres (evita perder
    // precisión en bigints grandes) - se normaliza a number aquí,
    // el único lugar que arma el payload público, para que
    // incident:reported/resolved/nearby siempre traigan el mismo
    // tipo de `id` sin importar el evento.
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
  /** Incidentes abiertos en memoria, keyed por id - evita ir a DB en cada fix de cada vehículo. */
  activeIncidents: Record<number, IncidentReportRow>;
  /** `${incidentId}:${deviceId}` → ya se le avisó mientras siga dentro del radio (no repetir cada segundo). */
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

  /** Carga los incidentes abiertos desde PostgreSQL - llamar una vez al arrancar el backend. */
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
    // Limpia cualquier "ya avisado" pendiente de este incidente -
    // si se vuelve a reportar en el mismo lugar, debe poder alertar de nuevo.
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

  /**
   * Resuelve todos los incidentes abiertos reportados desde un
   * dispositivo - se llama al eliminarlo, ANTES de que
   * `DeviceRepository.delete()` purgue sus filas de
   * `incident_reports` (`resolve()` hace un `UPDATE`, necesita que la
   * fila todavía exista - si se llamara después, `updated` vendría
   * `null` y ni el estado en memoria ni el broadcast en vivo se
   * limpiarían, dejando el incidente visible para siempre en el mapa
   * de Supervisor pese a que la fila en la base ya no exista).
   */
  async resolveDeviceIncidents(deviceId: string): Promise<void> {
    const ids = Object.values(this.activeIncidents)
      .filter((incident) => incident.device_id === deviceId)
      .map((incident) => incident.id);
    for (const id of ids) {
      await this.resolve(id, null);
    }
  }

  /**
   * Evalúa una posición nueva contra los incidentes abiertos del
   * MISMO proyecto - alerta una sola vez al entrar al radio, no en
   * cada fix mientras el vehículo siga dentro.
   */
  evaluate(position: EvaluatedPosition): void {
    Object.values(this.activeIncidents).forEach((incident) => {
      if (incident.project_id !== position.projectId) return;
      if (incident.device_id === position.deviceId) return; // no alertar al propio reportero

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
