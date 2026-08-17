/**
 * GeofenceAlertService.ts
 *
 * Responsabilidad: Evaluar si un vehículo está dentro
 * de una geocerca y emitir alertas al dispositivo
 * correspondiente y al panel de supervisor.
 *
 * Soporta 3 formas de geocerca (círculo, polígono, polilínea/
 * corredor) - la evaluación geométrica se delega a
 * backend/src/utils/geometry.ts. El comportamiento para geocercas
 * circulares es idéntico al original (misma fórmula de Haversine,
 * mismo resultado) - no se modificó esa lógica, solo se generalizó
 * para aceptar también polígonos y rutas.
 *
 * RF asociados: RF-ALR-02 (zona amarilla)
 *               RF-ALR-03 (zona roja)
 *               RF-ALR-04 (notificación a supervisor)
 */
import type { Geofence } from '@gaga-gps/shared-types';
import { getCorridorSeverity, isInsideGeofence } from '../../utils/geometry';

type Severity = 'warning' | 'danger' | 'info' | null;

interface EvaluatedPosition {
  deviceId: string;
  latitude: number;
  longitude: number;
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

interface SocketIoLike {
  emit(event: string, payload: unknown): void;
}

class GeofenceAlertService {
  io: SocketIoLike;
  activeGeofences: Geofence[];
  activeAlerts: Record<string, Severity>;
  geofenceEventRepo: GeofenceEventRepoLike | null;
  alertEventRepo: AlertEventRepoLike | null;

  constructor({
    io,
    geofenceEventRepo,
    alertEventRepo,
  }: {
    io: SocketIoLike;
    geofenceEventRepo?: GeofenceEventRepoLike;
    alertEventRepo?: AlertEventRepoLike;
  }) {
    this.io = io;
    // Geocercas activas en memoria
    // En producción vendrán de PostgreSQL
    this.activeGeofences = [];
    // Estado de alertas activas por dispositivo
    this.activeAlerts = {};
    // Opcional - si se provee, persiste eventos de entrada/salida
    // para auditoría e historial (ver geofence_events)
    this.geofenceEventRepo = geofenceEventRepo || null;
    // Opcional - historial unificado de alertas (ver alert_events),
    // separado de geofenceEventRepo (ese sigue siendo la fuente
    // operativa de entrada/salida; este es el log para "Activas"/
    // "Historial" del panel de Supervisor).
    this.alertEventRepo = alertEventRepo || null;
  }

  /**
   * Agrega o actualiza una geocerca activa.
   * type: 'warning' (amarilla) o 'danger' (roja)
   * shapeType: 'circle' (default) | 'polygon' | 'polyline'
   */
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

  /**
   * Elimina una geocerca por ID
   */
  removeGeofence(id: number): void {
    this.activeGeofences = this.activeGeofences.filter((g) => g.id !== id);
  }

  /**
   * Evalúa la posición de un vehículo contra todas las geocercas activas
   * Se llama cada vez que llega una posición nueva de un vehículo
   */
  evaluate(position: EvaluatedPosition): void {
    const { deviceId, latitude, longitude } = position;

    let maxSeverity: Severity = null;
    let triggeredGeofence: Geofence | null = null;

    // Evaluar contra cada geocerca activa - funciona igual para
    // círculo, polígono o polilínea/corredor (ver geometry.ts).
    // Para rutas (polyline), la severidad es progresiva según
    // distancia al eje (dentro del corredor → sin alerta, cerca del
    // borde → warning, fuera del margen → danger), no un tipo fijo.
    for (const geofence of this.activeGeofences) {
      let severity: Severity = null;

      if (geofence.shapeType === 'polyline') {
        severity = getCorridorSeverity(latitude, longitude, geofence);
      } else if (isInsideGeofence(latitude, longitude, geofence)) {
        severity =
          geofence.type === 'danger' ? 'danger' : geofence.type === 'parking' ? 'info' : 'warning';
      }

      if (severity === 'danger') {
        maxSeverity = 'danger';
        triggeredGeofence = geofence;
        break; // danger es máxima prioridad, no seguir evaluando
      } else if (severity === 'warning') {
        // No hace falta comparar maxSeverity !== 'danger' aquí: la
        // única forma de que maxSeverity llegue a 'danger' es la rama
        // de arriba, que siempre corta el loop con break - TypeScript
        // lo confirma (maxSeverity nunca puede ser 'danger' en este punto).
        maxSeverity = 'warning';
        triggeredGeofence = geofence;
      } else if (severity === 'info' && maxSeverity !== 'warning') {
        // 'info' (zona de estacionamiento) es la de menor prioridad -
        // no debe pisar un 'warning' ya encontrado en una geocerca
        // anterior de la misma posición.
        maxSeverity = 'info';
        triggeredGeofence = geofence;
      }
    }

    // Comparar con estado anterior para detectar cambios
    const previousAlert = this.activeAlerts[deviceId];

    if (maxSeverity && maxSeverity !== previousAlert) {
      // Vehículo entró a zona de alerta o escaló de nivel
      this.triggerAlert(deviceId, maxSeverity, triggeredGeofence as Geofence);
      this.activeAlerts[deviceId] = maxSeverity;
    } else if (!maxSeverity && previousAlert) {
      // Vehículo salió de todas las geocercas
      this.clearAlert(deviceId, previousAlert);
      this.activeAlerts[deviceId] = null;
    }
  }

  /**
   * Activa alerta en el dispositivo y notifica al supervisor
   */
  triggerAlert(deviceId: string, severity: 'warning' | 'danger' | 'info', geofence: Geofence): void {
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
      loop: severity === 'danger', // sirena en bucle solo para zona roja
      timestamp: new Date().toISOString(),
    };

    console.log(
      `ALERTA ${severity.toUpperCase()} - Device: ${deviceId} | Geocerca: ${geofence.name}`,
    );

    // Emitir al dispositivo específico
    // En producción usaremos rooms por deviceId
    if (severity === 'danger') {
      this.io.emit('alert:critical', alertPayload);
    } else if (severity === 'info') {
      // Sin sirena/sonido - solo aviso visual (RF de zonas de estacionamiento)
      this.io.emit('alert:info', alertPayload);
    } else {
      this.io.emit('alert:warning', alertPayload);
    }

    // Notificar al panel de supervisor
    this.io.emit('supervisor:alert', {
      ...alertPayload,
      action: 'entered',
    });

    this._persistEvent(deviceId, geofence.id, 'enter', severity);
    this._recordAlertEvent(deviceId, severity, messages[severity], { geofenceName: geofence.name });
  }

  /**
   * Cancela alertas activas cuando el vehículo sale de la geocerca
   */
  clearAlert(deviceId: string, previousSeverity: Severity): void {
    console.log(`Device ${deviceId} salió de la geocerca - cancelando alertas`);

    this.io.emit('alert:clear', {
      deviceId,
      timestamp: new Date().toISOString(),
    });

    this.io.emit('supervisor:alert', {
      deviceId,
      action: 'exited',
      timestamp: new Date().toISOString(),
    });

    this._persistEvent(deviceId, null, 'exit', previousSeverity);
    this._resolveAlertEvent(deviceId);
  }

  /**
   * Persiste el evento de entrada/salida para auditoría/historial,
   * sin bloquear el flujo en tiempo real (fire-and-forget) - un
   * fallo al guardar el evento no debe afectar la alerta ya emitida.
   */
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

  /**
   * Historial unificado de alertas (ver alert_events) - separado de
   * `_persistEvent` (esa sigue siendo la fuente operativa de
   * entrada/salida). Fire-and-forget, igual que `_persistEvent`.
   */
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

  /**
   * Retorna el estado actual de alertas activas
   * para enviar a clientes que se conectan tarde
   */
  getActiveAlerts(): Record<string, Severity> {
    return this.activeAlerts;
  }

  /**
   * Limpia el estado de un dispositivo eliminado - sin esto, una
   * alerta de geocerca abierta en el momento de eliminar el
   * dispositivo se queda "fantasma" en memoria para siempre
   * (`clearAlert` normalmente solo se dispara al recibir una nueva
   * posición que confirme que salió de la geocerca, y un dispositivo
   * eliminado nunca vuelve a reportar). Reutiliza `clearAlert` para
   * que un Supervisor ya conectado también vea la alerta resolverse
   * en vivo, no solo que desaparezca de la próxima hidratación.
   */
  clearDevice(deviceId: string): void {
    const previousAlert = this.activeAlerts[deviceId];
    if (previousAlert) {
      this.clearAlert(deviceId, previousAlert);
    }
    delete this.activeAlerts[deviceId];
  }
}

export default GeofenceAlertService;
