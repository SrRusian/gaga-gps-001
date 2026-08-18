/**
 * GeofenceAlertService.ts
 *
 * Responsabilidad: Evaluar si un vehículo está dentro
 * de una geocerca y emitir alertas al dispositivo
 * correspondiente y al panel de supervisor.
 *
 * Soporta 3 formas de geocerca (círculo, polígono, polilínea/
 * corredor). La evaluación en sí (¿qué geocercas matchean este
 * punto?) se delega a PostGIS vía `GeofenceRepository.findMatchingSpatial()`
 * (índice GiST, un solo query por posición) - antes se recorría
 * `activeGeofences` en JS con Haversine/ray-casting a mano
 * (`utils/geometry.ts`, que sigue existiendo para `reports.routes.ts`,
 * el cruce histórico fuera del camino caliente). `activeGeofences`
 * también se conserva - lo sigue usando `VehicleProximityService`
 * (exclusión por corredor) y la hidratación de sockets para que los
 * 3 paneles dibujen las geocercas en el mapa.
 *
 * Aislado por proyecto desde esta ronda: `evaluate()` solo matchea
 * geocercas del mismo proyecto que el dispositivo (antes evaluaba
 * contra las de TODOS los proyectos), y toda emisión usa
 * `socketServer.broadcastToProject()` en vez de un `io.emit` global.
 *
 * RF asociados: RF-ALR-02 (zona amarilla)
 *               RF-ALR-03 (zona roja)
 *               RF-ALR-04 (notificación a supervisor)
 */
import type { Geofence, GeofenceShapeType, GeofenceType } from '@gaga-gps/shared-types';

type Severity = 'warning' | 'danger' | 'info' | null;

interface EvaluatedPosition {
  deviceId: string;
  latitude: number;
  longitude: number;
  projectId: number | null;
}

/** Fila devuelta por GeofenceRepository.findMatchingSpatial() - ver ese archivo. */
interface GeofenceMatchRow {
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

/**
 * Severidad progresiva para un corredor a partir de una distancia YA
 * calculada por PostGIS (`ST_Distance`) - misma semántica de 3
 * niveles que tenía `getCorridorSeverity` en utils/geometry.ts, solo
 * que ahí la distancia se calculaba en JS y aquí llega resuelta.
 */
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
    // Opcional al construir - FleetSocketServer necesita a
    // geofenceService como su propia dependencia (para hidratar
    // activeGeofences a clientes nuevos), así que este servicio se
    // construye ANTES que el socket server exista - se asigna después
    // (ver app.ts), mismo patrón ya usado para
    // `socketServer.incidentAlertService`.
    socketServer?: SocketServerLike;
    geofenceEventRepo?: GeofenceEventRepoLike;
    alertEventRepo?: AlertEventRepoLike;
  }) {
    this.geofenceRepo = geofenceRepo;
    this.socketServer = socketServer || null;
    // Geocercas activas en memoria - ya no las usa evaluate() (ver
    // arriba), pero sigue siendo la fuente para VehicleProximityService
    // y para hidratar el mapa de los 3 paneles vía socket.
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
   * Evalúa la posición de un vehículo contra las geocercas de su
   * mismo proyecto - se llama cada vez que llega una posición nueva.
   * Un solo query indexado (PostGIS) reemplaza el loop en memoria de
   * antes; `projectId` viene ya resuelto en `position`
   * (PositionProcessor ya lo obtiene de `deviceManager`, sin
   * consulta adicional).
   */
  async evaluate(position: EvaluatedPosition): Promise<void> {
    const { deviceId, latitude, longitude, projectId } = position;

    const matches = await this.geofenceRepo.findMatchingSpatial({ projectId, latitude, longitude });

    let maxSeverity: Severity = null;
    let triggeredGeofence: GeofenceMatchRow | null = null;

    // Para rutas (polyline), la severidad es progresiva según
    // distancia al eje (dentro del corredor → sin alerta, cerca del
    // borde → warning, fuera del margen → danger), no un tipo fijo -
    // círculo/polígono solo aparecen en `matches` cuando el punto ya
    // está dentro (filtrado por PostGIS), así que su severidad es
    // directa por `type`.
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
      this.triggerAlert(deviceId, maxSeverity, triggeredGeofence as GeofenceMatchRow, projectId);
      this.activeAlerts[deviceId] = maxSeverity;
    } else if (!maxSeverity && previousAlert) {
      // Vehículo salió de todas las geocercas
      this.clearAlert(deviceId, previousAlert, projectId);
      this.activeAlerts[deviceId] = null;
    }
  }

  /**
   * Activa alerta en el dispositivo y notifica al supervisor - solo
   * a la sala del proyecto de este dispositivo (+ admins).
   */
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
      loop: severity === 'danger', // sirena en bucle solo para zona roja
      timestamp: new Date().toISOString(),
    };

    console.log(
      `ALERTA ${severity.toUpperCase()} - Device: ${deviceId} | Geocerca: ${geofence.name}`,
    );

    if (!this.socketServer) return;

    if (severity === 'danger') {
      this.socketServer.broadcastToProject(projectId, 'alert:critical', alertPayload);
    } else if (severity === 'info') {
      // Sin sirena/sonido - solo aviso visual (RF de zonas de estacionamiento)
      this.socketServer.broadcastToProject(projectId, 'alert:info', alertPayload);
    } else {
      this.socketServer.broadcastToProject(projectId, 'alert:warning', alertPayload);
    }

    // Notificar al panel de supervisor
    this.socketServer.broadcastToProject(projectId, 'supervisor:alert', {
      ...alertPayload,
      action: 'entered',
    });

    this._persistEvent(deviceId, geofence.id, 'enter', severity);
    this._recordAlertEvent(deviceId, severity, messages[severity], { geofenceName: geofence.name });
  }

  /**
   * Cancela alertas activas cuando el vehículo sale de la geocerca -
   * solo a la sala del proyecto de este dispositivo (+ admins).
   */
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
  clearDevice(deviceId: string, projectId: number | null): void {
    const previousAlert = this.activeAlerts[deviceId];
    if (previousAlert) {
      this.clearAlert(deviceId, previousAlert, projectId);
    }
    delete this.activeAlerts[deviceId];
  }
}

export default GeofenceAlertService;
