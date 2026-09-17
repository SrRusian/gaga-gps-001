import { speedInfractionSeverity } from '../../utils/infractionSeverity';

type Severity = 'warning' | 'danger' | null;

// alerta "casi en el limite" (90%) - explicitamente NO se clasifica como riesgo (pedido de Sergio en
// la llamada con el cliente), solo queda registrada como warning informativo
const WARNING_RATIO = 0.9;

interface GeofenceMatchLike {
  speed_limit_kmh: number | null;
}

interface DeviceRepoLike {
  findAlertContext(deviceId: string): Promise<{
    deviceLimit: number | null;
    groupLimit: number | null;
    vehicleTypeLimit: number | null;
  }>;
}

interface AlertEventRepoLike {
  recordOrEscalate(event: {
    alertType: 'speed';
    severity: 'warning' | 'danger';
    deviceId: string;
    message?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<unknown>;
  resolveOpen(event: { alertType: 'speed'; deviceId: string }): Promise<unknown>;
}

interface InfractionRepoLike {
  create(params: {
    projectId: number | null;
    deviceId: string;
    infractionType: 'speed';
    severity: number;
    message: string;
    latitude: number;
    longitude: number;
    metadata?: Record<string, unknown> | null;
  }): Promise<unknown>;
}

interface SocketServerLike {
  broadcastToProject(projectId: number | null, event: string, payload: unknown): void;
}

interface EvaluateParams {
  deviceId: string;
  speedKmh: number;
  projectId: number | null;
  geofenceMatches?: GeofenceMatchLike[];
  // solo se usan para registrar la infraccion (opcionales - sin ellas simplemente no se crea la
  // fila en `infractions`, el resto del comportamiento sigue igual)
  latitude?: number;
  longitude?: number;
}

// separado de GeofenceAlertService a proposito - combina el limite de la geocerca/ruta (si trae uno)
// con el del dispositivo y su grupo, gana siempre el mas estricto (pedido explicito del cliente)
class SpeedAlertService {
  deviceRepo: DeviceRepoLike;
  socketServer: SocketServerLike | null;
  alertEventRepo: AlertEventRepoLike | null;
  infractionRepo: InfractionRepoLike | null;
  activeAlerts: Record<string, Severity>;

  constructor({
    deviceRepo,
    socketServer,
    alertEventRepo,
    infractionRepo,
  }: {
    deviceRepo: DeviceRepoLike;
    socketServer?: SocketServerLike;
    alertEventRepo?: AlertEventRepoLike;
    infractionRepo?: InfractionRepoLike;
  }) {
    this.deviceRepo = deviceRepo;
    this.socketServer = socketServer || null;
    this.alertEventRepo = alertEventRepo || null;
    this.infractionRepo = infractionRepo || null;
    this.activeAlerts = {};
  }

  async evaluate({
    deviceId,
    speedKmh,
    projectId,
    geofenceMatches = [],
    latitude,
    longitude,
  }: EvaluateParams): Promise<void> {
    const candidates: number[] = geofenceMatches
      .map((g) => g.speed_limit_kmh)
      .filter((v): v is number => v != null);

    const { deviceLimit, groupLimit, vehicleTypeLimit } = await this.deviceRepo.findAlertContext(deviceId);
    if (deviceLimit != null) candidates.push(deviceLimit);
    if (groupLimit != null) candidates.push(groupLimit);
    if (vehicleTypeLimit != null) candidates.push(vehicleTypeLimit);

    const previousAlert = this.activeAlerts[deviceId] ?? null;

    if (candidates.length === 0) {
      if (previousAlert) {
        this.clearAlert(deviceId, projectId);
        this.activeAlerts[deviceId] = null;
      }
      return;
    }

    const effectiveLimit = Math.min(...candidates);
    const ratio = effectiveLimit > 0 ? speedKmh / effectiveLimit : 0;

    let severity: Severity = null;
    if (ratio >= 1) severity = 'danger';
    else if (ratio >= WARNING_RATIO) severity = 'warning';

    if (severity && severity !== previousAlert) {
      this.triggerAlert(deviceId, severity, speedKmh, effectiveLimit, projectId, latitude, longitude);
      this.activeAlerts[deviceId] = severity;
    } else if (!severity && previousAlert) {
      this.clearAlert(deviceId, projectId);
      this.activeAlerts[deviceId] = null;
    }
  }

  triggerAlert(
    deviceId: string,
    severity: 'warning' | 'danger',
    speedKmh: number,
    limitKmh: number,
    projectId: number | null,
    latitude?: number,
    longitude?: number,
  ): void {
    const roundedSpeed = Math.round(speedKmh);
    const roundedLimit = Math.round(limitKmh);
    const message =
      severity === 'danger'
        ? `EXCESO DE VELOCIDAD - ${roundedSpeed} km/h (límite ${roundedLimit} km/h)`
        : `VELOCIDAD ALTA - ${roundedSpeed} km/h (límite ${roundedLimit} km/h)`;

    const payload = {
      type: severity === 'danger' ? 'speed_danger' : 'speed_warning',
      deviceId,
      speedKmh: roundedSpeed,
      limitKmh: roundedLimit,
      message,
      loop: severity === 'danger',
      timestamp: new Date().toISOString(),
    };

    console.log(
      `ALERTA VELOCIDAD ${severity.toUpperCase()} - Device: ${deviceId} | ${roundedSpeed}km/h / límite ${roundedLimit}km/h`,
    );

    if (!this.socketServer) return;

    this.socketServer.broadcastToProject(
      projectId,
      severity === 'danger' ? 'alert:critical' : 'alert:warning',
      payload,
    );
    this.socketServer.broadcastToProject(projectId, 'supervisor:alert', {
      ...payload,
      action: 'entered',
    });

    // solo la infraccion real (100%+, "danger") se registra - el aviso temprano (90-99%, "warning")
    // sigue mostrandose al operador por socket mas arriba, pero ya no deja rastro en alert_events ni
    // en infractions (pedido explicito: en los registros solo se quieren infracciones reales, no
    // avisos previos que el operador pudo corregir a tiempo)
    if (severity === 'danger') {
      this._recordAlertEvent(deviceId, severity, message, {
        speedKmh: roundedSpeed,
        limitKmh: roundedLimit,
      });
      if (latitude != null && longitude != null) {
        this._recordInfraction(deviceId, projectId, message, roundedSpeed, roundedLimit, latitude, longitude);
      }
    }
  }

  _recordInfraction(
    deviceId: string,
    projectId: number | null,
    message: string,
    speedKmh: number,
    limitKmh: number,
    latitude: number,
    longitude: number,
  ): void {
    if (!this.infractionRepo) return;
    this.infractionRepo
      .create({
        projectId,
        deviceId,
        infractionType: 'speed',
        severity: speedInfractionSeverity(limitKmh > 0 ? speedKmh / limitKmh : 1),
        message,
        latitude,
        longitude,
        metadata: { speedKmh, limitKmh },
      })
      .catch((err: Error) => console.error('SpeedAlertService._recordInfraction:', err.message));
  }

  clearAlert(deviceId: string, projectId: number | null): void {
    console.log(`Device ${deviceId} volvió a velocidad segura - cancelando alerta de velocidad`);

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

    this._resolveAlertEvent(deviceId);
  }

  _recordAlertEvent(
    deviceId: string,
    severity: 'warning' | 'danger',
    message: string,
    metadata: Record<string, unknown>,
  ): void {
    if (!this.alertEventRepo) return;
    this.alertEventRepo
      .recordOrEscalate({ alertType: 'speed', severity, deviceId, message, metadata })
      .catch((err: Error) => console.error('SpeedAlertService._recordAlertEvent:', err.message));
  }

  _resolveAlertEvent(deviceId: string): void {
    if (!this.alertEventRepo) return;
    this.alertEventRepo
      .resolveOpen({ alertType: 'speed', deviceId })
      .catch((err: Error) => console.error('SpeedAlertService._resolveAlertEvent:', err.message));
  }

  getActiveAlerts(): Record<string, Severity> {
    return this.activeAlerts;
  }

  clearDevice(deviceId: string, projectId: number | null): void {
    const previousAlert = this.activeAlerts[deviceId];
    if (previousAlert) {
      this.clearAlert(deviceId, projectId);
    }
    delete this.activeAlerts[deviceId];
  }
}

export default SpeedAlertService;
