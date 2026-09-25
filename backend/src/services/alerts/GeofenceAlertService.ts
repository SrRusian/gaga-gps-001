import type { Geofence, GeofenceShapeType, GeofenceType } from '@gaga-gps/shared-types';
import { geofenceInfractionSeverity } from '../../utils/infractionSeverity';

type Severity = 'warning' | 'danger' | 'info' | null;

// la severidad SIEMPRE la decide el `type`, nunca la forma/distancia - la forma (circulo, poligono
// con/sin relleno, linea "debe quedarse dentro"/"no tocar") solo decide CUANDO se dispara esa
// severidad (ver el WHERE de GeofenceRepository.findMatchingSpatial). Ausente = sin alerta
// (allowed/discharge/carga son puramente informativas). 'authorized_route' quedo fuera a proposito
// (pedido explicito del usuario, corrigiendo el diseño anterior): salir de una ruta autorizada YA NO
// genera ninguna alerta - su unico proposito ahora es aportar speed_limit_kmh mientras el vehiculo
// va sobre ella (ver findMatchingSpatial) y servir de referencia para el sistema de distancia entre
// vehiculos de la misma ruta (CollisionRiskService, via GeofenceRepository.findRouteMembership,
// consulta completamente aparte que nunca dependio de esta severidad).
const AREA_SEVERITY: Partial<Record<GeofenceType, 'warning' | 'danger' | 'info'>> = {
  danger: 'danger',
  forbidden: 'danger',
  warning: 'warning',
  maintenance: 'warning',
  parking: 'info',
};

// mensaje/identidad de alerta por tipo - cada tipo alertable tiene su propio texto, no comparte
// el generico de peligro/advertencia (pedido explicito del usuario)
const AREA_ALERT_TEXT: Partial<Record<GeofenceType, { message: string; alertType: string }>> = {
  danger: { message: 'PELIGRO - DETENER VEHÍCULO INMEDIATAMENTE', alertType: 'geofence_red' },
  forbidden: {
    message: 'ZONA PROHIBIDA - NO INGRESAR - DETENER VEHÍCULO',
    alertType: 'geofence_forbidden',
  },
  warning: { message: 'PRECAUCIÓN - ZONA DE RIESGO - REDUCIR VELOCIDAD', alertType: 'geofence_yellow' },
  maintenance: { message: 'ZONA EN MANTENIMIENTO - PRECAUCIÓN', alertType: 'geofence_maintenance' },
  parking: { message: 'ZONA DE ESTACIONAMIENTO', alertType: 'geofence_parking' },
};

// gravedad fija para la infraccion de "salio de zona permitida siendo un dispositivo restringido" -
// no depende de tipo/proximidad como geofenceInfractionSeverity (no es una zona de peligro real, es
// un limite operativo), ajustable sin tocar arquitectura
const RESTRICTED_ZONE_INFRACTION_SEVERITY = 7;

// tipos con severidad real (no 'info') - fuente unica de verdad para el buffer de proximidad SQL.
// 'parking' (severidad 'info') queda fuera a proposito - puramente informativa, nunca genera aviso
// de proximidad (pedido explicito: solo zonas de riesgo real dan aviso elastico)
const ALERTABLE_TYPES: GeofenceType[] = (Object.entries(AREA_SEVERITY) as [GeofenceType, string][])
  .filter(([, sev]) => sev !== 'info')
  .map(([type]) => type);

// radio de busqueda SQL para candidatos de proximidad - techo de seguridad, la distancia real que
// dispara cada tier la deciden los umbrales de abajo (escalados por velocidad)
const PROXIMITY_LOOKAHEAD_MAX_METERS = 300;
// aviso silencioso (no se guarda, solo lo ve el operador) - distancia = max(piso fijo, velocidad*lookahead)
const SILENT_LOOKAHEAD_SECONDS = 12;
const SILENT_MIN_DISTANCE_M = 5;
// alerta urgente (se guarda, mismo canal/UI que la critica de siempre) - mas cerca/mas apremiante
const URGENT_LOOKAHEAD_SECONDS = 4;
const URGENT_MIN_DISTANCE_M = 1.5;

function resolveAlertText(
  geofence: { type: GeofenceType; name: string },
  severity: 'warning' | 'danger' | 'info',
  proximity: boolean,
): { message: string; alertType: string } {
  const base = AREA_ALERT_TEXT[geofence.type] ?? (severity === 'danger' ? AREA_ALERT_TEXT.danger! : AREA_ALERT_TEXT.warning!);
  if (!proximity) return base;
  return {
    message: `ACERCÁNDOSE A ZONA DE RIESGO - "${geofence.name}" - REDUZCA VELOCIDAD`,
    alertType: base.alertType,
  };
}

interface EvaluatedPosition {
  deviceId: string;
  latitude: number;
  longitude: number;
  projectId: number | null;
  // m/s, post-estimacion (ver SpeedEstimationService) - escala los umbrales elasticos de proximidad;
  // ausente/0 = umbrales al piso minimo (vehiculo detenido o sin dato)
  speed?: number;
  // rectangulo orientado real del vehiculo, ya agrandado por precision GPS (ver
  // backend/src/utils/vehicleFootprint.ts) - null si el dispositivo no tiene tipo de vehiculo
  // asignado o rumbo confiable todavia (cae al punto crudo de siempre, sin buffer, cero regresion)
  footprintWkt?: string | null;
  accuracy?: number;
  // TRUE = este dispositivo debe permanecer dentro de cualquier geocerca tipo 'allowed' - salir
  // genera infraccion + alerta. FALSE (default) = puede entrar/salir libremente, solo queda
  // registrado en geofence_events. Ver devices.restricted_to_allowed_zone.
  restrictedToAllowedZone?: boolean;
}

export interface GeofenceMatchRow {
  id: number;
  name: string;
  type: GeofenceType;
  shape_type: GeofenceShapeType;
  speed_limit_kmh: number | null;
  distance_meters: number;
  // opcional para no romper fixtures de test existentes que no lo setean - ausente se trata como
  // true (comportamiento historico: "matcheo" siempre significo "ya toca/adentro")
  contained?: boolean;
}

interface GeofenceRepoLike {
  findMatchingSpatial(params: {
    projectId: number | null;
    latitude: number;
    longitude: number;
    footprintWkt?: string | null;
    accuracyMeters?: number;
    alertableTypes?: string[];
    proximityLookaheadMeters?: number;
  }): Promise<GeofenceMatchRow[]>;
}

interface InfractionRepoLike {
  create(params: {
    projectId: number | null;
    deviceId: string;
    infractionType: 'geofence';
    severity: number;
    message: string;
    latitude: number;
    longitude: number;
    metadata?: Record<string, unknown> | null;
  }): Promise<unknown>;
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
    alertType: 'geofence' | 'restricted_zone';
    severity: 'info' | 'warning' | 'danger';
    deviceId: string;
    message?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<unknown>;
  resolveOpen(event: { alertType: 'geofence' | 'restricted_zone'; deviceId: string }): Promise<unknown>;
}

interface SocketServerLike {
  broadcastToProject(projectId: number | null, event: string, payload: unknown): void;
  // solo llega si esa tableta tiene el socket conectado ahora (ver FleetSocketServer.sendToDevice) -
  // usado para el aviso silencioso de proximidad, que NUNCA debe llegarle a nadie mas que al propio
  // operador (no broadcastToProject, no supervisor:alert)
  sendToDevice?(deviceId: string, event: string, payload: unknown): void;
}

class GeofenceAlertService {
  geofenceRepo: GeofenceRepoLike;
  socketServer: SocketServerLike | null;
  activeGeofences: Geofence[];
  activeAlerts: Record<string, Severity>;
  // boolean | undefined explicito (no solo Record<string, boolean>) - undefined distingue "nunca se
  // evaluo este dispositivo todavia" de "ya se evaluo y esta afuera", ver evaluate(). Solo se usa
  // para decidir cuando registrar una TRANSICION en geofence_events (entrar/salir) - nunca para
  // decidir la violacion de zona restringida, que es un estado por NIVEL (ver activeRestrictedViolations).
  activeAllowedZones: Record<string, boolean | undefined>;
  // true = este dispositivo restringido tiene una violacion activa AHORA MISMO (esta afuera de
  // "allowed") - por nivel, no por transicion. Separado de activeAllowedZones a proposito: un
  // dispositivo que arranca (o que este proceso ve por primera vez) ya afuera de la zona tambien
  // debe alertar de inmediato, no solo el que "sale" durante la vida del proceso.
  activeRestrictedViolations: Record<string, boolean>;
  geofenceEventRepo: GeofenceEventRepoLike | null;
  alertEventRepo: AlertEventRepoLike | null;
  infractionRepo: InfractionRepoLike | null;
  // historial de las ultimas 2 distancias por par deviceId+geofenceId - mismo patron que
  // CollisionRiskService.positionHistory, para decidir "¿se esta acercando de verdad?"
  distanceHistoryByKey: Record<string, number[]>;
  activeSilentNotices: Record<string, boolean>;
  // false = la alerta de zona la decide la tableta y el servidor solo registra lo que ella reporta
  // (ver el bloque en evaluate()). Default false: es el modo vigente del proyecto.
  evaluateAreaAlerts: boolean;
  // false = la violacion de zona restringida tambien la decide la tableta ahora (25 sep, pedido
  // explicito: el servidor le manda el flag restricted_to_allowed_zone a la tableta - ver
  // device:config en FleetSocketServer - y ella evalua/reporta, igual que el resto de geocercas).
  // Default false: modo vigente. Se deja el codigo de abajo intacto (no borrado) como referencia
  // canonica de la copia que corre en la tableta - mismo criterio que evaluateAreaAlerts.
  evaluateRestrictedZone: boolean;

  constructor({
    geofenceRepo,
    socketServer,
    geofenceEventRepo,
    alertEventRepo,
    infractionRepo,
    evaluateAreaAlerts = false,
    evaluateRestrictedZone = false,
  }: {
    geofenceRepo: GeofenceRepoLike;
    socketServer?: SocketServerLike;
    geofenceEventRepo?: GeofenceEventRepoLike;
    alertEventRepo?: AlertEventRepoLike;
    infractionRepo?: InfractionRepoLike;
    evaluateAreaAlerts?: boolean;
    evaluateRestrictedZone?: boolean;
  }) {
    this.geofenceRepo = geofenceRepo;
    this.socketServer = socketServer || null;
    this.activeGeofences = [];
    this.activeAlerts = {};
    this.activeAllowedZones = {};
    this.activeRestrictedViolations = {};
    this.geofenceEventRepo = geofenceEventRepo || null;
    this.alertEventRepo = alertEventRepo || null;
    this.infractionRepo = infractionRepo || null;
    this.distanceHistoryByKey = {};
    this.activeSilentNotices = {};
    this.evaluateAreaAlerts = evaluateAreaAlerts;
    this.evaluateRestrictedZone = evaluateRestrictedZone;
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

  async evaluate(position: EvaluatedPosition): Promise<GeofenceMatchRow[]> {
    const { deviceId, latitude, longitude, projectId } = position;
    const speedMs = position.speed ?? 0;

    const matches = await this.geofenceRepo.findMatchingSpatial({
      projectId,
      latitude,
      longitude,
      footprintWkt: position.footprintWkt ?? null,
      accuracyMeters: position.accuracy ?? 0,
      alertableTypes: ALERTABLE_TYPES,
      proximityLookaheadMeters: PROXIMITY_LOOKAHEAD_MAX_METERS,
    });

    // undefined (nunca se evaluo antes) en vez de defaultear a false/true - evita un falso "salio"/
    // "entro" en geofence_events en la primera posicion real de un dispositivo solo por no conocer
    // su estado anterior. Esto es correcto SOLO para el historial de transiciones (tiempo en zona) -
    // nunca debe usarse para decidir la violacion de zona restringida (ver bloque de abajo).
    const previousInAllowed = this.activeAllowedZones[deviceId];
    const matchedAllowedZone = matches.find((g) => g.type === 'allowed') ?? null;
    const inAllowed = matchedAllowedZone !== null;
    if (previousInAllowed !== undefined && previousInAllowed !== inAllowed) {
      this._persistEvent(deviceId, inAllowed ? matchedAllowedZone!.id : null, inAllowed ? 'enter' : 'exit', null);
    }
    this.activeAllowedZones[deviceId] = inAllowed;

    // violacion de zona restringida - por NIVEL ("¿esta afuera ahora?"), no por transicion (bug real
    // corregido 25 sep, ver historial). Desde el mismo dia, esta decision se movio a la tableta (el
    // servidor le manda el flag restricted_to_allowed_zone via device:config y ella evalua/reporta
    // localmente, igual que el resto de geocercas) - este bloque solo corre si evaluateRestrictedZone
    // esta activo (false en produccion), se deja como referencia canonica sin borrar.
    if (this.evaluateRestrictedZone) {
      if (position.restrictedToAllowedZone) {
        const wasViolating = this.activeRestrictedViolations[deviceId] ?? false;
        if (!inAllowed && !wasViolating) {
          this.activeRestrictedViolations[deviceId] = true;
          this._triggerRestrictedZoneViolation(deviceId, projectId, latitude, longitude);
        } else if (inAllowed && wasViolating) {
          this.activeRestrictedViolations[deviceId] = false;
          this._clearRestrictedZoneViolation(deviceId, projectId);
        }
      } else if (this.activeRestrictedViolations[deviceId]) {
        // dejo de estar restringido (se desmarco) mientras tenia una violacion activa - limpiar
        // para no dejar una alerta fantasma que nunca se resuelve
        this.activeRestrictedViolations[deviceId] = false;
        this._clearRestrictedZoneViolation(deviceId, projectId);
      }
    }

    let maxSeverity: Severity = null;
    let triggeredGeofence: GeofenceMatchRow | null = null;
    let triggeredProximity = false;
    let bestSilent: { geofence: GeofenceMatchRow; distanceMeters: number } | null = null;

    for (const geofence of matches) {
      const severity: Severity = AREA_SEVERITY[geofence.type] ?? null;
      if (!severity) continue;

      const contained = geofence.contained ?? true;
      let eligible = contained;
      let proximity = false;

      // no contenido todavia (solo circle/polygon filled con severidad real llegan aqui, via el
      // buffer de proximidad de la consulta espacial) - tier elastico segun distancia+velocidad,
      // solo si el vehiculo de verdad se esta acercando (no solo pasando cerca en paralelo)
      if (!contained) {
        const converging = this._trackDistance(deviceId, geofence.id, geofence.distance_meters);
        const urgentDistance = Math.max(URGENT_MIN_DISTANCE_M, speedMs * URGENT_LOOKAHEAD_SECONDS);
        const silentDistance = Math.max(SILENT_MIN_DISTANCE_M, speedMs * SILENT_LOOKAHEAD_SECONDS);

        if (converging && geofence.distance_meters <= urgentDistance) {
          eligible = true;
          proximity = true;
        } else if (converging && geofence.distance_meters <= silentDistance) {
          if (!bestSilent || geofence.distance_meters < bestSilent.distanceMeters) {
            bestSilent = { geofence, distanceMeters: geofence.distance_meters };
          }
        }
      }

      if (!eligible) continue;

      if (severity === 'danger') {
        maxSeverity = 'danger';
        triggeredGeofence = geofence;
        triggeredProximity = proximity;
        break;
      } else if (severity === 'warning') {
        maxSeverity = 'warning';
        triggeredGeofence = geofence;
        triggeredProximity = proximity;
      } else if (severity === 'info' && maxSeverity !== 'warning') {
        maxSeverity = 'info';
        triggeredGeofence = geofence;
        triggeredProximity = proximity;
      }
    }

    const previousAlert = this.activeAlerts[deviceId];

    // La alerta de ZONA (entrar a una geocerca con severidad) la decide ahora la propia tableta y
    // la reporta a device-events.routes.ts - decision explicita del usuario. Aqui se deja de
    // emitirla para no duplicar alertas ni infracciones. Lo que SI se sigue evaluando en el
    // servidor es lo que la tableta no puede resolver sola: la zona restringida (necesita saber si
    // ESTE dispositivo tiene permiso, dato del servidor) y los tiers elasticos de acercamiento
    // (necesitan ST_Buffer/ST_Distance contra la geometria real en PostGIS). Ver el bloque de
    // arriba y _evaluateSilentTier, que siguen corriendo.
    if (!this.evaluateAreaAlerts) {
      if (previousAlert) {
        this.clearAlert(deviceId, previousAlert, projectId);
        this.activeAlerts[deviceId] = null;
      }
      this._evaluateSilentTier(deviceId, bestSilent);
      return matches;
    }

    if (maxSeverity && maxSeverity !== previousAlert) {
      this.triggerAlert(
        deviceId,
        maxSeverity,
        triggeredGeofence as GeofenceMatchRow,
        projectId,
        triggeredProximity,
        latitude,
        longitude,
      );
      this.activeAlerts[deviceId] = maxSeverity;
    } else if (!maxSeverity && previousAlert) {
      this.clearAlert(deviceId, previousAlert, projectId);
      this.activeAlerts[deviceId] = null;
    }

    this._evaluateSilentTier(deviceId, bestSilent);

    return matches;
  }

  // true = la distancia viene decreciendo respecto a la muestra anterior (se esta acercando de
  // verdad) - mismo patron que CollisionRiskService.areConverging, evita avisar a un vehiculo que
  // solo pasa cerca en paralelo o se aleja
  _trackDistance(deviceId: string, geofenceId: number, distanceMeters: number): boolean {
    const key = `${deviceId}:${geofenceId}`;
    const history = this.distanceHistoryByKey[key] ?? [];
    history.push(distanceMeters);
    if (history.length > 2) history.shift();
    this.distanceHistoryByKey[key] = history;
    return history.length >= 2 && history[1] < history[0];
  }

  // aviso silencioso - SOLO al operador (sendToDevice, nunca broadcastToProject/supervisor:alert) y
  // NUNCA se guarda (ni alert_events ni infractions) - canal propio (alert:proximity_notice/clear),
  // deliberadamente separado del slot de alerta real para no arriesgar que un clear silencioso borre
  // por accidente una alerta critica que ya este en pantalla (ver plan - modelo de un solo slot)
  _evaluateSilentTier(
    deviceId: string,
    best: { geofence: GeofenceMatchRow; distanceMeters: number } | null,
  ): void {
    if (best) {
      this.activeSilentNotices[deviceId] = true;
      if (!this.socketServer?.sendToDevice) return;
      this.socketServer.sendToDevice(deviceId, 'alert:proximity_notice', {
        deviceId,
        geofenceId: best.geofence.id,
        geofenceName: best.geofence.name,
        distanceMeters: Math.round(best.distanceMeters),
        message: `Precaución - cerca de "${best.geofence.name}"`,
        timestamp: new Date().toISOString(),
      });
    } else if (this.activeSilentNotices[deviceId]) {
      this.activeSilentNotices[deviceId] = false;
      if (!this.socketServer?.sendToDevice) return;
      this.socketServer.sendToDevice(deviceId, 'alert:proximity_clear', {
        deviceId,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // "zona permitida" (verde) es ahora el limite operativo real (ej. contorno completo de la mina) -
  // solo dispara algo si el DISPOSITIVO esta marcado como restringido (devices.restricted_to_allowed_
  // zone); uno sin restriccion entra/sale libre, sin ningun aviso, solo queda el registro en
  // geofence_events (ver evaluate()). Estado independiente de `activeAlerts` a proposito (alert_type
  // propio 'restricted_zone') - no comparte el mismo slot que danger/warning/info de otras geocercas,
  // para no repetir el bug real de produccion de esta misma sesion (una severidad enmascarando a otra).
  _triggerRestrictedZoneViolation(
    deviceId: string,
    projectId: number | null,
    latitude: number,
    longitude: number,
  ): void {
    const message = 'FUERA DE ZONA PERMITIDA - REGRESE DE INMEDIATO';
    const payload = {
      type: 'restricted_zone_violation',
      deviceId,
      message,
      loop: true,
      timestamp: new Date().toISOString(),
    };

    console.log(`ALERTA ZONA RESTRINGIDA - Device: ${deviceId} salió de la zona permitida`);

    if (this.socketServer) {
      this.socketServer.broadcastToProject(projectId, 'alert:critical', payload);
      this.socketServer.broadcastToProject(projectId, 'supervisor:alert', { ...payload, action: 'entered' });
    }

    this._recordRestrictedZoneAlertEvent(deviceId, message);
    this._recordRestrictedZoneInfraction(deviceId, projectId, message, latitude, longitude);
  }

  _clearRestrictedZoneViolation(deviceId: string, projectId: number | null): void {
    console.log(`Device ${deviceId} regresó a la zona permitida`);

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

    this._resolveRestrictedZoneAlertEvent(deviceId);
  }

  _recordRestrictedZoneInfraction(
    deviceId: string,
    projectId: number | null,
    message: string,
    latitude: number,
    longitude: number,
  ): void {
    if (!this.infractionRepo) return;
    this.infractionRepo
      .create({
        projectId,
        deviceId,
        infractionType: 'geofence',
        severity: RESTRICTED_ZONE_INFRACTION_SEVERITY,
        message,
        latitude,
        longitude,
        metadata: { reason: 'restricted_zone_exit' },
      })
      .catch((err: Error) => console.error('GeofenceAlertService._recordRestrictedZoneInfraction:', err.message));
  }

  _recordRestrictedZoneAlertEvent(deviceId: string, message: string): void {
    if (!this.alertEventRepo) return;
    this.alertEventRepo
      .recordOrEscalate({ alertType: 'restricted_zone', severity: 'danger', deviceId, message, metadata: {} })
      .catch((err: Error) => console.error('GeofenceAlertService._recordRestrictedZoneAlertEvent:', err.message));
  }

  _resolveRestrictedZoneAlertEvent(deviceId: string): void {
    if (!this.alertEventRepo) return;
    this.alertEventRepo
      .resolveOpen({ alertType: 'restricted_zone', deviceId })
      .catch((err: Error) => console.error('GeofenceAlertService._resolveRestrictedZoneAlertEvent:', err.message));
  }

  triggerAlert(
    deviceId: string,
    severity: 'warning' | 'danger' | 'info',
    geofence: { id: number; name: string; type: GeofenceType },
    projectId: number | null,
    proximity = false,
    latitude?: number,
    longitude?: number,
  ): void {
    const { message, alertType } = resolveAlertText(geofence, severity, proximity);

    const alertPayload = {
      type: alertType,
      deviceId,
      geofenceId: geofence.id,
      geofenceName: geofence.name,
      message,
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
    this._recordAlertEvent(deviceId, severity, message, { geofenceName: geofence.name, proximity });

    // infraccion real (permanente, revisable por un encargado) - solo warning/danger (nunca 'info',
    // ej. parking) y solo en la transicion (este metodo ya solo se llama cuando la severidad cambia
    // de verdad, ver evaluate()) - "las alertas peligrosas siempre se registran", sin importar si
    // fue por tocar la zona o por la alerta urgente de proximidad
    if ((severity === 'danger' || severity === 'warning') && latitude != null && longitude != null) {
      this._recordInfraction(deviceId, projectId, geofence, message, latitude, longitude, proximity);
    }
  }

  _recordInfraction(
    deviceId: string,
    projectId: number | null,
    geofence: { id: number; name: string; type: GeofenceType },
    message: string,
    latitude: number,
    longitude: number,
    proximity: boolean,
  ): void {
    if (!this.infractionRepo) return;
    this.infractionRepo
      .create({
        projectId,
        deviceId,
        infractionType: 'geofence',
        severity: geofenceInfractionSeverity(geofence.type, proximity),
        message: `${message} - Geocerca "${geofence.name}"`,
        latitude,
        longitude,
        metadata: { geofenceId: geofence.id, geofenceName: geofence.name, geofenceType: geofence.type, proximity },
      })
      .catch((err: Error) => console.error('GeofenceAlertService._recordInfraction:', err.message));
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
    // idempotente (resolveOpen/alert:clear sin nada abierto es un no-op seguro) - mas simple que
    // rastrear aparte si el dispositivo era restringido y tenia una violacion activa en este momento
    this._clearRestrictedZoneViolation(deviceId, projectId);
    delete this.activeAllowedZones[deviceId];
    delete this.activeRestrictedViolations[deviceId];

    if (this.activeSilentNotices[deviceId] && this.socketServer?.sendToDevice) {
      this.socketServer.sendToDevice(deviceId, 'alert:proximity_clear', {
        deviceId,
        timestamp: new Date().toISOString(),
      });
    }
    delete this.activeSilentNotices[deviceId];
    Object.keys(this.distanceHistoryByKey).forEach((key) => {
      if (key.startsWith(`${deviceId}:`)) delete this.distanceHistoryByKey[key];
    });
  }
}

export default GeofenceAlertService;
