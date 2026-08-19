import type { Geofence, GeofenceShapeType, GeofenceType } from '@gaga-gps/shared-types';

type Severity = 'warning' | 'danger' | 'info' | null;

interface EvaluatedPosition {
  deviceId: string;
  latitude: number;
  longitude: number;
  projectId: number | null;
}

export interface GeofenceMatchRow {
  id: number;
  name: string;
  type: GeofenceType;
  shape_type: GeofenceShapeType;
  corridor_width_meters: number | null;
  corridor_danger_margin_meters: number | null;
  distance_meters: number;
}

interface GeofenceRepoLike {
  findMatchingSpatial(params: {
    projectId: number | null;
    latitude: number;
    longitude: number;
  }): Promise<GeofenceMatchRow[]>;
}

interface GeofenceEventRepoLike {
  record(event: {
    deviceId: string;
    geofenceId: number | null;
    eventType: 'enter' | 'exit';
    severity?: string | null;
  }): Promise<unknown>;
}

interface AlertEventRepoLike {
  recordOrEscalate(event: {
    alertType: 'geofence';
    severity: 'info' | 'warning' | 'danger';
    deviceId: string;
    message?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<unknown>;
  resolveOpen(event: { alertType: 'geofence'; deviceId: string }): Promise<unknown>;
}

interface SocketServerLike {
  broadcastToProject(projectId: number | null, event: string, payload: unknown): void;
}

function corridorSeverityFromDistance(
  distanceMeters: number,
  corridorWidthMeters: number,
  corridorDangerMarginMeters: number | null,
): Severity {
  if (distanceMeters <= corridorWidthMeters) return null;
  if (corridorDangerMarginMeters && distanceMeters > corridorWidthMeters + corridorDangerMarginMeters) {
    return 'danger';
  }
  return 'warning';
}

class GeofenceAlertService {
  geofenceRepo: GeofenceRepoLike;
  socketServer: SocketServerLike | null;
  activeGeofences: Geofence[];
  activeAlerts: Record<string, Severity>;
  geofenceEventRepo: GeofenceEventRepoLike | null;
  alertEventRepo: AlertEventRepoLike | null;

  constructor({
    geofenceRepo,
    socketServer,
    geofenceEventRepo,
    alertEventRepo,
  }: {
    geofenceRepo: GeofenceRepoLike;
    socketServer?: SocketServerLike;
    geofenceEventRepo?: GeofenceEventRepoLike;
    alertEventRepo?: AlertEventRepoLike;
  }) {
    this.geofenceRepo = geofenceRepo;
    this.socketServer = socketServer || null;
    this.activeGeofences = [];
    this.activeAlerts = {};
    this.geofenceEventRepo = geofenceEventRepo || null;
    this.alertEventRepo = alertEventRepo || null;
  }

  addGeofence(geofence: Partial<Geofence> & { id: number }): void {
    const normalized = { shapeType: 'circle', ...geofence } as Geofence;
    const existing = this.activeGeofences.findIndex((g) => g.id === normalized.id);
    if (existing >= 0) {
      this.activeGeofences[existing] = normalized;
    } else {
      this.activeGeofences.push(normalized);
    }
    const shapeInfo =
      normalized.shapeType === 'circle'
        ? `Radio: ${normalized.radiusMeters}m`
        : `Forma: ${normalized.shapeType}`;
    console.log(`Geocerca registrada: ${normalized.name} (${normalized.type}) - ${shapeInfo}`);
  }

  removeGeofence(id: number): void {
    this.activeGeofences = this.activeGeofences.filter((g) => g.id !== id);
  }

  async evaluate(position: EvaluatedPosition): Promise<void> {
    const { deviceId, latitude, longitude, projectId } = position;

    const matches = await this.geofenceRepo.findMatchingSpatial({ projectId, latitude, longitude });

    let maxSeverity: Severity = null;
    let triggeredGeofence: GeofenceMatchRow | null = null;

    for (const geofence of matches) {
      let severity: Severity = null;

      if (geofence.shape_type === 'polyline') {
        severity = corridorSeverityFromDistance(
          geofence.distance_meters,
          geofence.corridor_width_meters as number,
          geofence.corridor_danger_margin_meters,
        );
      } else {
        severity =
          geofence.type === 'danger' ? 'danger' : geofence.type === 'parking' ? 'info' : 'warning';
      }

      if (severity === 'danger') {
        maxSeverity = 'danger';
        triggeredGeofence = geofence;
        break;
      } else if (severity === 'warning') {
        maxSeverity = 'warning';
        triggeredGeofence = geofence;
      } else if (severity === 'info' && maxSeverity !== 'warning') {
        maxSeverity = 'info';
        triggeredGeofence = geofence;
      }
    }

    const previousAlert = this.activeAlerts[deviceId];

    if (maxSeverity && maxSeverity !== previousAlert) {
      this.triggerAlert(deviceId, maxSeverity, triggeredGeofence as GeofenceMatchRow, projectId);
      this.activeAlerts[deviceId] = maxSeverity;
    } else if (!maxSeverity && previousAlert) {
      this.clearAlert(deviceId, previousAlert, projectId);
      this.activeAlerts[deviceId] = null;
    }
  }

  triggerAlert(
    deviceId: string,
    severity: 'warning' | 'danger' | 'info',
    geofence: { id: number; name: string },
    projectId: number | null,
  ): void {
    const messages = {
      warning: 'PRECAUCIÓN - ZONA DE RIESGO - REDUCIR VELOCIDAD',
      danger: 'PELIGRO - DETENER VEHÍCULO INMEDIATAMENTE',
      info: 'ZONA DE ESTACIONAMIENTO',
    };
    const types = {
      warning: 'geofence_yellow',
      danger: 'geofence_red',
      info: 'geofence_parking',
    } as const;

    const alertPayload = {
      type: types[severity],
      deviceId,
      geofenceId: geofence.id,
      geofenceName: geofence.name,
      message: messages[severity],
      loop: severity === 'danger',
      timestamp: new Date().toISOString(),
    };

    console.log(
      `ALERTA ${severity.toUpperCase()} - Device: ${deviceId} | Geocerca: ${geofence.name}`,
    );

    if (!this.socketServer) return;

    if (severity === 'danger') {
      this.socketServer.broadcastToProject(projectId, 'alert:critical', alertPayload);
    } else if (severity === 'info') {
      this.socketServer.broadcastToProject(projectId, 'alert:info', alertPayload);
    } else {
      this.socketServer.broadcastToProject(projectId, 'alert:warning', alertPayload);
    }

    this.socketServer.broadcastToProject(projectId, 'supervisor:alert', {
      ...alertPayload,
      action: 'entered',
    });

    this._persistEvent(deviceId, geofence.id, 'enter', severity);
    this._recordAlertEvent(deviceId, severity, messages[severity], { geofenceName: geofence.name });
  }

  clearAlert(deviceId: string, previousSeverity: Severity, projectId: number | null): void {
    console.log(`Device ${deviceId} salió de la geocerca - cancelando alertas`);

    if (this.socketServer) {
      this.socketServer.broadcastToProject(projectId, 'alert:clear', {
        deviceId,
        timestamp: new Date().toISOString(),
      });

      this.socketServer.broadcastToProject(projectId, 'supervisor:alert', {
        deviceId,
        action: 'exited',
        timestamp: new Date().toISOString(),
      });
    }

    this._persistEvent(deviceId, null, 'exit', previousSeverity);
    this._resolveAlertEvent(deviceId);
  }

  _persistEvent(
    deviceId: string,
    geofenceId: number | null,
    eventType: 'enter' | 'exit',
    severity: Severity,
  ): void {
    if (!this.geofenceEventRepo) return;
    this.geofenceEventRepo
      .record({ deviceId, geofenceId, eventType, severity })
      .catch((err: Error) => console.error('GeofenceAlertService._persistEvent:', err.message));
  }

  _recordAlertEvent(
    deviceId: string,
    severity: 'warning' | 'danger' | 'info',
    message: string,
    metadata: Record<string, unknown>,
  ): void {
    if (!this.alertEventRepo) return;
    this.alertEventRepo
      .recordOrEscalate({ alertType: 'geofence', severity, deviceId, message, metadata })
      .catch((err: Error) => console.error('GeofenceAlertService._recordAlertEvent:', err.message));
  }

  _resolveAlertEvent(deviceId: string): void {
    if (!this.alertEventRepo) return;
    this.alertEventRepo
      .resolveOpen({ alertType: 'geofence', deviceId })
      .catch((err: Error) => console.error('GeofenceAlertService._resolveAlertEvent:', err.message));
  }

  getActiveAlerts(): Record<string, Severity> {
    return this.activeAlerts;
  }

  clearDevice(deviceId: string, projectId: number | null): void {
    const previousAlert = this.activeAlerts[deviceId];
    if (previousAlert) {
      this.clearAlert(deviceId, previousAlert, projectId);
    }
    delete this.activeAlerts[deviceId];
  }
}

export default GeofenceAlertService;
