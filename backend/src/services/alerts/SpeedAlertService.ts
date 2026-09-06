type Severity = 'warning' | 'danger' | null;

// alerta "casi en el limite" (90%) - explicitamente NO se clasifica como riesgo (pedido de Sergio en
// la llamada con el cliente), solo queda registrada como warning informativo
const WARNING_RATIO = 0.9;

interface GeofenceMatchLike {
  speed_limit_kmh: number | null;
}

interface DeviceRepoLike {
  findSpeedLimits(deviceId: string): Promise<{ deviceLimit: number | null; groupLimit: number | null }>;
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

interface SocketServerLike {
  broadcastToProject(projectId: number | null, event: string, payload: unknown): void;
}

interface EvaluateParams {
  deviceId: string;
  speedKmh: number;
  projectId: number | null;
  geofenceMatches?: GeofenceMatchLike[];
}

// separado de GeofenceAlertService a proposito - combina el limite de la geocerca/ruta (si trae uno)
// con el del dispositivo y su grupo, gana siempre el mas estricto (pedido explicito del cliente)
class SpeedAlertService {
  deviceRepo: DeviceRepoLike;
  socketServer: SocketServerLike | null;
  alertEventRepo: AlertEventRepoLike | null;
  activeAlerts: Record<string, Severity>;

  constructor({
    deviceRepo,
    socketServer,
    alertEventRepo,
  }: {
    deviceRepo: DeviceRepoLike;
    socketServer?: SocketServerLike;
    alertEventRepo?: AlertEventRepoLike;
  }) {
    this.deviceRepo = deviceRepo;
    this.socketServer = socketServer || null;
    this.alertEventRepo = alertEventRepo || null;
    this.activeAlerts = {};
  }

  async evaluate({ deviceId, speedKmh, projectId, geofenceMatches = [] }: EvaluateParams): Promise<void> {
    const candidates: number[] = geofenceMatches
      .map((g) => g.speed_limit_kmh)
      .filter((v): v is number => v != null);

    const { deviceLimit, groupLimit } = await this.deviceRepo.findSpeedLimits(deviceId);
    if (deviceLimit != null) candidates.push(deviceLimit);
    if (groupLimit != null) candidates.push(groupLimit);

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
      this.triggerAlert(deviceId, severity, speedKmh, effectiveLimit, projectId);
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

    this._recordAlertEvent(deviceId, severity, message, {
      speedKmh: roundedSpeed,
      limitKmh: roundedLimit,
    });
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
