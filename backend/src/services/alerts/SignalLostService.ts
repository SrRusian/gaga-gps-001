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
  activatedBy: PreventiveStopTriggeredBy | null;
  activate(reason: string, triggeredBy?: PreventiveStopTriggeredBy): void;
  deactivate(triggeredBy?: string): void;
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
  // ultima vez que ESTE dispositivo reporto movimiento real - decide si al perder senal se usa el
  // umbral corto (iba andando) o el largo (llevaba rato parado)
  lastMovingAt: Record<string, number>;
  alertLevel: Record<string, AlertLevel>;
  projectByDevice: Record<string, number | null>;
  // dispositivos en suspension de energia autorizada (ver power-events.routes.ts) - checkAllDevices
  // los salta por completo mientras dure, aunque lleven horas/dias sin mandar nada
  suspendedDevices: Record<string, boolean>;
  // dispositivos cuya ultima posicion reportada estaba dentro de una zona permitida/estacionamiento
  // (lo reporta la propia tableta, ver device-events). Una tableta estacionada ahi puede quedarse
  // sin señal sin que sea un problema operativo - pedido explicito
  zoneExemptDevices: Record<string, boolean>;
  // desde cuando un dispositivo caido volvio a reportar - la alerta no se limpia hasta que lleve
  // RECOVERY_STABLE_MS reportando seguido, para no encender/apagar el aviso en cada bache de red
  recoveringSince: Record<string, number>;
  checkInterval: ReturnType<typeof setInterval> | null;
  // 5s: pedido explicito. El proyecto se entera de que ese vehiculo esta sin señal casi de
  // inmediato, en vez de a los 20s - con telemetria de 1/seg, 5 posiciones perdidas seguidas ya
  // no son un bache normal de red
  readonly LEVEL1_MS = 5000;
  readonly LEVEL2_MS = 15000;

  // Un vehiculo DETENIDO que pierde senal unos segundos casi siempre es un bache del GNSS (perdida
  // de fix bajo techo/estructura), no una emergencia - medido en campo: 32 alertas en un dia con la
  // tableta parada en el mismo lugar, todas por huecos de 5-15s del receptor. Un vehiculo EN
  // MOVIMIENTO que desaparece es otra cosa (volcadura, accidente) y conserva los umbrales cortos.
  readonly LEVEL1_STATIONARY_MS = 30000;
  readonly LEVEL2_STATIONARY_MS = 60000;
  // debajo de esto no se considera movimiento real (mismo criterio que COURSE_TRUST_MIN_KMH)
  readonly MOVING_SPEED_KMH = 3;
  // hay que llevar parado al menos esto para que aplique el umbral largo - un vehiculo que acaba de
  // frenar sigue tratandose como en movimiento
  readonly STATIONARY_SETTLE_MS = 60000;
  readonly RECOVERY_STABLE_MS = 5000;

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
    this.lastMovingAt = {};
    this.alertLevel = {};
    this.projectByDevice = {};
    this.suspendedDevices = {};
    this.zoneExemptDevices = {};
    this.recoveringSince = {};
    this.checkInterval = null;
  }

  // lo reporta la propia tableta junto con su evaluacion de geocercas (ver device-events.routes):
  // si se desconecta estando dentro de una zona permitida/estacionamiento, no se alarma a nadie.
  // Se conserva el ULTIMO estado reportado a proposito - es justo el que vale cuando ya no hay
  // forma de preguntarle donde esta
  setZoneExempt(deviceId: string, exempt: boolean): void {
    if (exempt) this.zoneExemptDevices[deviceId] = true;
    else delete this.zoneExemptDevices[deviceId];
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

  recordPosition(deviceId: string, projectId: number | null = null, speedKmh?: number | null): void {
    const wasLost = this.alertLevel[deviceId];
    const now = Date.now();
    // se inicializa en la primera posicion para que un dispositivo recien visto no cuente como
    // "parado hace rato" sin haberlo observado nunca
    if (this.lastMovingAt[deviceId] === undefined || (typeof speedKmh === 'number' && speedKmh >= this.MOVING_SPEED_KMH)) {
      this.lastMovingAt[deviceId] = now;
    }
    this.lastSeen[deviceId] = now;
    this.projectByDevice[deviceId] = projectId;
    // cualquier posicion real (encendido normal, o interaccion sospechosa sin corriente - ver
    // power-events.routes.ts) significa que ya no esta "silenciosamente suspendido"
    delete this.suspendedDevices[deviceId];

    if (!wasLost || wasLost === 'none') {
      delete this.recoveringSince[deviceId];
      this.alertLevel[deviceId] = 'none';
      return;
    }

    // ya reconecto, pero la alerta NO se levanta al primer paquete: tiene que sostener la conexion
    // RECOVERY_STABLE_MS seguidos. Sin esto, una red intermitente encendia y apagaba el aviso a
    // los demas del proyecto cada pocos segundos (pedido explicito: esperar a que este estable)
    const since = this.recoveringSince[deviceId];
    if (since === undefined) {
      this.recoveringSince[deviceId] = now;
      return;
    }
    if (now - since < this.RECOVERY_STABLE_MS) return;

    delete this.recoveringSince[deviceId];
    this.alertLevel[deviceId] = 'none';
    this.handleRecovery(deviceId);
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
      // estacionado dentro de una zona permitida cuando se desconecto - no se alarma a nadie
      if (this.zoneExemptDevices[deviceId]) return;
      const elapsed = now - lastTime;
      const currentLevel = this.alertLevel[deviceId] || 'none';
      const lastMoving = this.lastMovingAt[deviceId];
      const stationary = lastMoving !== undefined && lastTime - lastMoving >= this.STATIONARY_SETTLE_MS;
      const level1Ms = stationary ? this.LEVEL1_STATIONARY_MS : this.LEVEL1_MS;
      const level2Ms = stationary ? this.LEVEL2_STATIONARY_MS : this.LEVEL2_MS;

      // volvio a caerse antes de completar la ventana de estabilidad: la cuenta se reinicia, no se
      // arrastra el progreso de una reconexion que no llego a sostenerse
      if (elapsed >= level1Ms) delete this.recoveringSince[deviceId];

      if (elapsed >= level2Ms && currentLevel !== 'level2') {
        this.triggerLevel2(deviceId, elapsed);
        this.alertLevel[deviceId] = 'level2';
        this._markDeviceOffline(deviceId);
      } else if (elapsed >= level1Ms && currentLevel === 'none') {
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

    // el mensaje guardado debe bastar por si solo para identificar el vehiculo - a diferencia de los
    // mensajes en vivo de arriba, este es el unico texto que le llega al Encargado/Supervisor via
    // alerts:snapshot (reconexion) o el historial, que no traen un campo de deviceId aparte
    this._recordAlertEvent(deviceId, 'warning', `Vehículo ${deviceId} sin señal por ${seconds}s`, {
      elapsedSeconds: seconds,
    });
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

    this._recordAlertEvent(deviceId, 'danger', `Vehículo ${deviceId} sin señal por ${seconds}s - emergencia`, {
      elapsedSeconds: seconds,
    });

    // El ALTO TOTAL de todo el proyecto ya NO se activa solo por una tableta sin señal (decision
    // explicita del usuario). Motivo real: en un viaje de 110 minutos se dispararon 23 paradas
    // globales por baches de cobertura de UNA tableta, frenando a toda la flota sin razon. Ahora
    // el resto del proyecto solo se ENTERA (supervisor:signal_lost + signal:lost:level2 en tercera
    // persona, arriba) y sigue operando; el alto total lo aplica la tableta afectada sobre si misma,
    // con su propio vigilante local - que es ademas el unico que puede actuar estando sin red.
    // El supervisor conserva la parada manual de siempre.
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
    this._maybeAutoClearPreventiveStop(deviceId);
  }

  // el ALTO TOTAL solo se auto-desactiva si lo disparo esta misma clase (nunca pisa una activacion
  // manual del supervisor) y si ya no queda NINGUN otro dispositivo en nivel 2 (danger real) - antes
  // de esto quedaba encendido para siempre hasta que un supervisor lo apagara a mano, aunque el
  // vehiculo que lo disparo ya hubiera recuperado señal
  _maybeAutoClearPreventiveStop(recoveredDeviceId: string): void {
    if (!this.preventiveStopService.isActive) return;
    if (this.preventiveStopService.activatedBy !== 'auto') return;
    const stillDown = Object.entries(this.alertLevel).some(
      ([deviceId, level]) => deviceId !== recoveredDeviceId && level === 'level2',
    );
    if (stillDown) return;
    this.preventiveStopService.deactivate('auto');
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
    delete this.zoneExemptDevices[deviceId];
    delete this.recoveringSince[deviceId];
  }
}

export default SignalLostService;
