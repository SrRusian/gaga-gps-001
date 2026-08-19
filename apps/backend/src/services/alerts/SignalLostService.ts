import type { PreventiveStopTriggeredBy } from './PreventiveStopService';

interface SocketIoLike {
  emit(event: string, payload: unknown): void;
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

class SignalLostService {
  io: SocketIoLike;
  preventiveStopService: PreventiveStopServiceLike;
  deviceManager?: DeviceManagerLike;
  alertEventRepo?: AlertEventRepoLike;
  lastSeen: Record<string, number>;
  alertLevel: Record<string, AlertLevel>;
  checkInterval: ReturnType<typeof setInterval> | null;
  readonly LEVEL1_MS = 10000;
  readonly LEVEL2_MS = 20000;

  constructor({
    io,
    preventiveStopService,
    deviceManager,
    alertEventRepo,
  }: {
    io: SocketIoLike;
    preventiveStopService: PreventiveStopServiceLike;
    deviceManager?: DeviceManagerLike;
    alertEventRepo?: AlertEventRepoLike;
  }) {
    this.io = io;
    this.preventiveStopService = preventiveStopService;
    this.deviceManager = deviceManager;
    this.alertEventRepo = alertEventRepo;
    this.lastSeen = {};
    this.alertLevel = {};
    this.checkInterval = null;
  }

  hydrate(records: { deviceId: string; lastSeenAt: Date }[]): void {
    records.forEach(({ deviceId, lastSeenAt }) => {
      this.lastSeen[deviceId] = lastSeenAt.getTime();
    });
  }

  recordPosition(deviceId: string): void {
    const wasLost = this.alertLevel[deviceId];
    this.lastSeen[deviceId] = Date.now();

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

  triggerLevel1(deviceId: string, elapsed: number): void {
    const seconds = Math.round(elapsed / 1000);
    console.log(` NIVEL 1 - Device ${deviceId} sin señal por ${seconds}s`);

    this.io.emit('signal:lost:level1', {
      deviceId: parseInt(deviceId),
      elapsedSeconds: seconds,
      message: `PRECAUCIÓN - VEHÍCULO ${deviceId} SIN SEÑAL - REDUZCA VELOCIDAD`,
      timestamp: new Date().toISOString(),
    });

    this.io.emit('supervisor:signal_lost', {
      deviceId: parseInt(deviceId),
      level: 1,
      elapsedSeconds: seconds,
      timestamp: new Date().toISOString(),
    });

    this._recordAlertEvent(deviceId, 'warning', `Sin señal por ${seconds}s`, { elapsedSeconds: seconds });
  }

  triggerLevel2(deviceId: string, elapsed: number): void {
    const seconds = Math.round(elapsed / 1000);
    console.log(`NIVEL 2 EMERGENCIA - Device ${deviceId} sin señal por ${seconds}s`);

    this.io.emit('signal:lost:level2', {
      deviceId: parseInt(deviceId),
      elapsedSeconds: seconds,
      message: `EMERGENCIA - VEHÍCULO ${deviceId} DESCONECTADO - DETÉNGASE Y REPORTE A CENTRAL`,
      loop: true,
      timestamp: new Date().toISOString(),
    });

    this.io.emit('supervisor:signal_lost', {
      deviceId: parseInt(deviceId),
      level: 2,
      elapsedSeconds: seconds,
      timestamp: new Date().toISOString(),
    });

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
    console.log(`Device ${deviceId} reconectado - cancelando emergencia`);

    this.io.emit('signal:recovered', {
      deviceId: parseInt(deviceId),
      message: `VEHÍCULO ${deviceId} RECONECTADO - OPERACIÓN NORMAL`,
      timestamp: new Date().toISOString(),
    });

    this.io.emit('supervisor:signal_lost', {
      deviceId: parseInt(deviceId),
      level: 0,
      message: 'Reconectado',
      timestamp: new Date().toISOString(),
    });

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
  }
}

export default SignalLostService;
