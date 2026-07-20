/**
 * SignalLostService.js
 *
 * Responsabilidad: Detectar pérdida de señal de vehículos
 * y ejecutar protocolo de emergencia colectiva.
 *
 * Nivel 1 — 45 segundos sin señal: alerta a toda la flota
 * Nivel 2 — 90 segundos sin señal: emergencia colectiva
 *
 * RF asociados: RF-ALR-05
 */

class SignalLostService {

  constructor({ io }) {
    this.io = io;
    this.lastSeen = {};
    this.alertLevel = {};
    this.checkInterval = null;

    // Umbrales — mayores al refresco en reposo de 30s
    this.LEVEL1_MS = 45000;  // 45 segundos
    this.LEVEL2_MS = 90000;  // 90 segundos
  }

  recordPosition(deviceId) {
    const wasLost = this.alertLevel[deviceId];
    this.lastSeen[deviceId] = Date.now();

    if (wasLost && wasLost !== 'none') {
      this.handleRecovery(deviceId);
    }

    this.alertLevel[deviceId] = 'none';
  }

  startMonitoring() {
    console.log('SignalLostService: Monitoreo iniciado');
    this.checkInterval = setInterval(() => {
      this.checkAllDevices();
    }, 5000);
  }

  stopMonitoring() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  checkAllDevices() {
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

  triggerLevel1(deviceId, elapsed) {
    const seconds = Math.round(elapsed / 1000);
    console.log(`⚠️  NIVEL 1 — Device ${deviceId} sin señal por ${seconds}s`);

    this.io.emit('signal:lost:level1', {
      deviceId: parseInt(deviceId),
      elapsedSeconds: seconds,
      message: `PRECAUCIÓN — VEHÍCULO ${deviceId} SIN SEÑAL — REDUZCA VELOCIDAD`,
      timestamp: new Date().toISOString()
    });

    this.io.emit('supervisor:signal_lost', {
      deviceId: parseInt(deviceId),
      level: 1,
      elapsedSeconds: seconds,
      timestamp: new Date().toISOString()
    });
  }

  triggerLevel2(deviceId, elapsed) {
    const seconds = Math.round(elapsed / 1000);
    console.log(`🚨 NIVEL 2 EMERGENCIA — Device ${deviceId} sin señal por ${seconds}s`);

    this.io.emit('signal:lost:level2', {
      deviceId: parseInt(deviceId),
      elapsedSeconds: seconds,
      message: `EMERGENCIA — VEHÍCULO ${deviceId} DESCONECTADO — DETÉNGASE Y REPORTE A CENTRAL`,
      loop: true,
      timestamp: new Date().toISOString()
    });

    this.io.emit('supervisor:signal_lost', {
      deviceId: parseInt(deviceId),
      level: 2,
      elapsedSeconds: seconds,
      timestamp: new Date().toISOString()
    });
  }

  handleRecovery(deviceId) {
    console.log(`✅ Device ${deviceId} reconectado — cancelando emergencia`);

    this.io.emit('signal:recovered', {
      deviceId: parseInt(deviceId),
      message: `VEHÍCULO ${deviceId} RECONECTADO — OPERACIÓN NORMAL`,
      timestamp: new Date().toISOString()
    });

    this.io.emit('supervisor:signal_lost', {
      deviceId: parseInt(deviceId),
      level: 0,
      message: 'Reconectado',
      timestamp: new Date().toISOString()
    });
  }
}

module.exports = SignalLostService;