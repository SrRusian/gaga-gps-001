/**
 * SignalLostService.ts
 *
 * Responsabilidad: Detectar pérdida de señal de vehículos
 * y ejecutar protocolo de emergencia colectiva.
 *
 * Nivel 1 — 45 segundos sin señal: alerta a toda la flota
 * Nivel 2 — 90 segundos sin señal: emergencia colectiva
 *
 * RF asociados: RF-ALR-05
 */
import type PreventiveStopService from './PreventiveStopService';

interface SocketIoLike {
  emit(event: string, payload: unknown): void;
}

type AlertLevel = 'none' | 'level1' | 'level2';

class SignalLostService {
  io: SocketIoLike;
  preventiveStopService: PreventiveStopService;
  lastSeen: Record<string, number>;
  alertLevel: Record<string, AlertLevel>;
  checkInterval: ReturnType<typeof setInterval> | null;
  readonly LEVEL1_MS = 45000;
  readonly LEVEL2_MS = 90000;

  constructor({
    io,
    preventiveStopService,
  }: {
    io: SocketIoLike;
    preventiveStopService: PreventiveStopService;
  }) {
    this.io = io;
    this.preventiveStopService = preventiveStopService;
    this.lastSeen = {};
    this.alertLevel = {};
    this.checkInterval = null;
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
      } else if (elapsed >= this.LEVEL1_MS && currentLevel === 'none') {
        this.triggerLevel1(deviceId, elapsed);
        this.alertLevel[deviceId] = 'level1';
      }
    });
  }

  triggerLevel1(deviceId: string, elapsed: number): void {
    const seconds = Math.round(elapsed / 1000);
    console.log(`⚠️  NIVEL 1 — Device ${deviceId} sin señal por ${seconds}s`);

    this.io.emit('signal:lost:level1', {
      deviceId: parseInt(deviceId),
      elapsedSeconds: seconds,
      message: `PRECAUCIÓN — VEHÍCULO ${deviceId} SIN SEÑAL — REDUZCA VELOCIDAD`,
      timestamp: new Date().toISOString(),
    });

    this.io.emit('supervisor:signal_lost', {
      deviceId: parseInt(deviceId),
      level: 1,
      elapsedSeconds: seconds,
      timestamp: new Date().toISOString(),
    });
  }

  triggerLevel2(deviceId: string, elapsed: number): void {
    const seconds = Math.round(elapsed / 1000);
    console.log(`🚨 NIVEL 2 EMERGENCIA — Device ${deviceId} sin señal por ${seconds}s`);

    this.io.emit('signal:lost:level2', {
      deviceId: parseInt(deviceId),
      elapsedSeconds: seconds,
      message: `EMERGENCIA — VEHÍCULO ${deviceId} DESCONECTADO — DETÉNGASE Y REPORTE A CENTRAL`,
      loop: true,
      timestamp: new Date().toISOString(),
    });

    this.io.emit('supervisor:signal_lost', {
      deviceId: parseInt(deviceId),
      level: 2,
      elapsedSeconds: seconds,
      timestamp: new Date().toISOString(),
    });

    // Activar parada preventiva colectiva automáticamente — RF-ALR-11
    if (this.preventiveStopService && !this.preventiveStopService.isActive) {
      this.preventiveStopService.activate(
        `Vehículo ${deviceId} sin señal por ${seconds} segundos`,
        'auto',
      );
    }
  }

  handleRecovery(deviceId: string): void {
    console.log(`✅ Device ${deviceId} reconectado — cancelando emergencia`);

    this.io.emit('signal:recovered', {
      deviceId: parseInt(deviceId),
      message: `VEHÍCULO ${deviceId} RECONECTADO — OPERACIÓN NORMAL`,
      timestamp: new Date().toISOString(),
    });

    this.io.emit('supervisor:signal_lost', {
      deviceId: parseInt(deviceId),
      level: 0,
      message: 'Reconectado',
      timestamp: new Date().toISOString(),
    });
  }
}

export default SignalLostService;
