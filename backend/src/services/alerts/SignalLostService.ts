import type { PreventiveStopTriggeredBy } from './PreventiveStopService';

interface SocketServerLike {
  sendToDevice(deviceId: string, event: string, payload: unknown): void;
  broadcastToProject(projectId: number | null, event: string, payload: unknown): void;
  broadcastToProjectExceptDevice(
    projectId: number | null,
    excludeDeviceId: string,
    event: string,
    payload: unknown,
  ): void;
}

interface PreventiveStopServiceLike {
  isActive: boolean;
  activate(reason: string, triggeredBy?: PreventiveStopTriggeredBy): void;
}

interface DeviceManagerLike {
  markOffline(uniqueId: string): Promise<void>;
}

interface AlertEventRepoLike {
  recordOrEscalate(event: {
    alertType: 'signal_lost';
    severity: 'warning' | 'danger';
    deviceId: string;
    message?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<unknown>;
  resolveOpen(event: { alertType: 'signal_lost'; deviceId: string }): Promise<unknown>;
}

type AlertLevel = 'none' | 'level1' | 'level2';

// deviceId es texto (ej. "T1"), nunca numerico - el codigo viejo hacia parseInt(deviceId) antes de
// emitir, que da NaN para cualquier id no puramente numerico (bug real, silencioso: rompia
// cualquier intento de comparar el deviceId recibido contra el propio). Nunca parsear a numero aqui.
class SignalLostService {
  // se asigna despues de construir (ver app.ts) - evita ciclo con FleetSocketServer, mismo patron
  // ya usado por GeofenceAlertService/SpeedAlertService
  socketServer: SocketServerLike | null;
  preventiveStopService: PreventiveStopServiceLike;
  deviceManager?: DeviceManagerLike;
  alertEventRepo?: AlertEventRepoLike;
  lastSeen: Record<string, number>;
  alertLevel: Record<string, AlertLevel>;
  projectByDevice: Record<string, number | null>;
  // dispositivos en suspension de energia autorizada (ver power-events.routes.ts) - checkAllDevices
  // los salta por completo mientras dure, aunque lleven horas/dias sin mandar nada
  suspendedDevices: Record<string, boolean>;
  checkInterval: ReturnType<typeof setInterval> | null;
  readonly LEVEL1_MS = 10000;
  readonly LEVEL2_MS = 20000;

  constructor({
    socketServer,
    preventiveStopService,
    deviceManager,
    alertEventRepo,
  }: {
    socketServer?: SocketServerLike;
    preventiveStopService: PreventiveStopServiceLike;
    deviceManager?: DeviceManagerLike;
    alertEventRepo?: AlertEventRepoLike;
  }) {
    this.socketServer = socketServer || null;
    this.preventiveStopService = preventiveStopService;
    this.deviceManager = deviceManager;
    this.alertEventRepo = alertEventRepo;
    this.lastSeen = {};
    this.alertLevel = {};
    this.projectByDevice = {};
    this.suspendedDevices = {};
    this.checkInterval = null;
  }

  // el dispositivo avisó que perdió corriente dentro de una geocerca tipo estacionamiento
  // (type=parking) - deja de contar como "sin señal" mientras dure, sin importar cuánto tiempo pase
  suspendDevice(deviceId: string): void {
    this.suspendedDevices[deviceId] = true;
  }

  // corriente restaurada o interacción detectada - vuelve a contar sin_señal normal. No dispara
  // handleRecovery() por sí solo: eso ya lo hace recordPosition() en cuanto llegue una posición real
  resumeDevice(deviceId: string): void {
    delete this.suspendedDevices[deviceId];
  }

  hydrate(records: { deviceId: string; lastSeenAt: Date; projectId: number | null }[]): void {
    records.forEach(({ deviceId, lastSeenAt, projectId }) => {
      this.lastSeen[deviceId] = lastSeenAt.getTime();
      this.projectByDevice[deviceId] = projectId;
    });
  }

  recordPosition(deviceId: string, projectId: number | null = null): void {
    const wasLost = this.alertLevel[deviceId];
    this.lastSeen[deviceId] = Date.now();
    this.projectByDevice[deviceId] = projectId;
    // cualquier posicion real (encendido normal, o interaccion sospechosa sin corriente - ver
    // power-events.routes.ts) significa que ya no esta "silenciosamente suspendido"
    delete this.suspendedDevices[deviceId];

    if (wasLost && wasLost !== 'none') {
      this.handleRecovery(deviceId);
    }

    this.alertLevel[deviceId] = 'none';
  }

  startMonitoring(): void {
    console.log('SignalLostService: Monitoreo iniciado');
    this.checkInterval = setInterval(() => {
      this.checkAllDevices();
    }, 5000);
  }

  stopMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  checkAllDevices(): void {
    const now = Date.now();

    Object.entries(this.lastSeen).forEach(([deviceId, lastTime]) => {
      if (this.suspendedDevices[deviceId]) return;
      const elapsed = now - lastTime;
      const currentLevel = this.alertLevel[deviceId] || 'none';

      if (elapsed >= this.LEVEL2_MS && currentLevel !== 'level2') {
        this.triggerLevel2(deviceId, elapsed);
        this.alertLevel[deviceId] = 'level2';
        this._markDeviceOffline(deviceId);
      } else if (elapsed >= this.LEVEL1_MS && currentLevel === 'none') {
        this.triggerLevel1(deviceId, elapsed);
        this.alertLevel[deviceId] = 'level1';
        this._markDeviceOffline(deviceId);
      }
    });
  }

  _markDeviceOffline(deviceId: string): void {
    this.deviceManager
      ?.markOffline(deviceId)
      .catch((err: Error) => console.error('SignalLostService.markOffline:', err.message));
  }

  // dos audiencias con el mismo evento, mensaje distinto: al propio vehiculo se le avisa en
  // primera persona (via sendToDevice - solo le llega si tiene la app abierta y conectada en este
  // momento), al resto del proyecto en tercera persona ("por seguridad, todos deben saber") - ver
  // FleetSocketServer.broadcastToProjectExceptDevice
  triggerLevel1(deviceId: string, elapsed: number): void {
    const seconds = Math.round(elapsed / 1000);
    const projectId = this.projectByDevice[deviceId] ?? null;
    console.log(` NIVEL 1 - Device ${deviceId} sin señal por ${seconds}s`);

    if (this.socketServer) {
      const base = { deviceId, elapsedSeconds: seconds, timestamp: new Date().toISOString() };
      this.socketServer.sendToDevice(deviceId, 'signal:lost:level1', {
        ...base,
        message: 'PRECAUCIÓN - PERDISTE LA CONEXIÓN - REDUZCA VELOCIDAD',
      });
      this.socketServer.broadcastToProjectExceptDevice(projectId, deviceId, 'signal:lost:level1', {
        ...base,
        message: `PRECAUCIÓN - VEHÍCULO ${deviceId} SIN SEÑAL - REDUZCA VELOCIDAD`,
      });

      this.socketServer.broadcastToProject(projectId, 'supervisor:signal_lost', {
        deviceId,
        level: 1,
        elapsedSeconds: seconds,
        timestamp: new Date().toISOString(),
      });
    }

    this._recordAlertEvent(deviceId, 'warning', `Sin señal por ${seconds}s`, { elapsedSeconds: seconds });
  }

  triggerLevel2(deviceId: string, elapsed: number): void {
    const seconds = Math.round(elapsed / 1000);
    const projectId = this.projectByDevice[deviceId] ?? null;
    console.log(`NIVEL 2 EMERGENCIA - Device ${deviceId} sin señal por ${seconds}s`);

    if (this.socketServer) {
      const base = { deviceId, elapsedSeconds: seconds, loop: true, timestamp: new Date().toISOString() };
      this.socketServer.sendToDevice(deviceId, 'signal:lost:level2', {
        ...base,
        message: 'EMERGENCIA - PERDISTE LA CONEXIÓN - DETENTE Y REPORTA A CENTRAL',
      });
      this.socketServer.broadcastToProjectExceptDevice(projectId, deviceId, 'signal:lost:level2', {
        ...base,
        message: `EMERGENCIA - VEHÍCULO ${deviceId} DESCONECTADO - DETÉNGASE Y REPORTE A CENTRAL`,
      });

      this.socketServer.broadcastToProject(projectId, 'supervisor:signal_lost', {
        deviceId,
        level: 2,
        elapsedSeconds: seconds,
        timestamp: new Date().toISOString(),
      });
    }

    this._recordAlertEvent(deviceId, 'danger', `Sin señal por ${seconds}s - emergencia`, {
      elapsedSeconds: seconds,
    });

    if (this.preventiveStopService && !this.preventiveStopService.isActive) {
      this.preventiveStopService.activate(
        `Vehículo ${deviceId} sin señal por ${seconds} segundos`,
        'auto',
      );
    }
  }

  handleRecovery(deviceId: string): void {
    const projectId = this.projectByDevice[deviceId] ?? null;
    console.log(`Device ${deviceId} reconectado - cancelando emergencia`);

    if (this.socketServer) {
      const base = { deviceId, timestamp: new Date().toISOString() };
      this.socketServer.sendToDevice(deviceId, 'signal:recovered', {
        ...base,
        message: 'RECUPERASTE LA CONEXIÓN - OPERACIÓN NORMAL',
      });
      this.socketServer.broadcastToProjectExceptDevice(projectId, deviceId, 'signal:recovered', {
        ...base,
        message: `VEHÍCULO ${deviceId} RECONECTADO - OPERACIÓN NORMAL`,
      });

      this.socketServer.broadcastToProject(projectId, 'supervisor:signal_lost', {
        deviceId,
        level: 0,
        message: 'Reconectado',
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
      .recordOrEscalate({ alertType: 'signal_lost', severity, deviceId, message, metadata })
      .catch((err: Error) => console.error('SignalLostService._recordAlertEvent:', err.message));
  }

  _resolveAlertEvent(deviceId: string): void {
    if (!this.alertEventRepo) return;
    this.alertEventRepo
      .resolveOpen({ alertType: 'signal_lost', deviceId })
      .catch((err: Error) => console.error('SignalLostService._resolveAlertEvent:', err.message));
  }

  clearDevice(deviceId: string): void {
    const wasLost = this.alertLevel[deviceId];
    if (wasLost && wasLost !== 'none') {
      this.handleRecovery(deviceId);
    }
    delete this.lastSeen[deviceId];
    delete this.alertLevel[deviceId];
    delete this.projectByDevice[deviceId];
    delete this.suspendedDevices[deviceId];
  }
}

export default SignalLostService;
