import { collisionInfractionSeverity } from '../../utils/infractionSeverity';
import { footprintsOverlap } from '../../utils/vehicleFootprint';

interface SocketIoLike {
  emit(event: string, payload: unknown): void;
}

// solo para el aviso silencioso (operador unicamente) del tier de ruta - deliberadamente separado
// de SocketIoLike de arriba, que sigue siendo el canal global sin cambios para el resto del archivo
interface SocketServerLike {
  sendToDevice(deviceId: string, event: string, payload: unknown): void;
}

interface AlertEventRepoLike {
  recordOrEscalate(event: {
    alertType: 'collision';
    severity: 'warning' | 'danger';
    deviceId: string;
    deviceId2: string;
    message?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<unknown>;
  resolveOpen(event: { alertType: 'collision'; deviceId: string; deviceId2: string }): Promise<unknown>;
}

interface InfractionRepoLike {
  create(params: {
    projectId: number | null;
    deviceId: string;
    deviceId2?: string | null;
    infractionType: 'collision';
    severity: number;
    message: string;
    latitude: number;
    longitude: number;
    metadata?: Record<string, unknown> | null;
  }): Promise<unknown>;
}

interface RouteMembership {
  id: number;
  name: string;
  corridorWidthMeters: number;
  lineFraction: number;
}

interface GeofenceRepoLike {
  findRouteMembership(params: {
    projectId: number | null;
    latitude: number;
    longitude: number;
  }): Promise<RouteMembership | null>;
}

interface EvaluatedPosition {
  deviceId: number | string;
  latitude: number;
  longitude: number;
  // los siguientes 3 solo se usan para el tier de ruta (silencioso/direccion) - ausentes = ese
  // dispositivo simplemente nunca entra al camino de ruta, sigue con el comportamiento generico de
  // siempre (mismo criterio de "cero regresion" que el resto de la feature de footprint)
  projectId?: number | null;
  speed?: number; // m/s
  footprintWkt?: string | null;
}

interface HistoryPoint {
  lat: number;
  lon: number;
  timestamp: number;
}

type CollisionAlertLevel = 'none' | 'proximity' | 'critical' | 'contact';

// direccion de recorrido a lo largo de una ruta (fraccion 0=inicio..1=fin creciendo o decreciendo) -
// null = todavia no se sabe (primera vez que se ve en esta ruta, o fraccion sin cambio detectable)
type RouteDirection = 'forward' | 'backward' | null;

interface RouteState {
  geofenceId: number;
  geofenceName: string;
  fraction: number;
  direction: RouteDirection;
}

// umbral minimo de cambio de fraccion para decidir direccion - por debajo de esto se considera
// ruido de GPS y se mantiene la direccion ya conocida (mismo espiritu que la zona muerta ya usada
// en otros tiers elasticos de este proyecto)
const ROUTE_FRACTION_DEADBAND = 0.0015;
// aviso silencioso (ruta, misma o distinta direccion) - mas lejos que el umbral de "proximity" de
// siempre (80m) a proposito, para que sea genuinamente el aviso MAS temprano de los 3
const ROUTE_SILENT_MIN_DISTANCE_M = 100;
const ROUTE_SILENT_LOOKAHEAD_SECONDS = 10;

// global, no filtra por proyecto para el camino generico (gap de aislamiento conocido, documentado) -
// el camino de RUTA si es project-aware (una ruta es siempre de un proyecto especifico)
class CollisionRiskService {
  io: SocketIoLike;
  socketServer: SocketServerLike | null;
  alertEventRepo?: AlertEventRepoLike;
  infractionRepo?: InfractionRepoLike;
  geofenceRepo?: GeofenceRepoLike;
  positionHistory: Record<string, HistoryPoint[]>;
  collisionAlerts: Record<string, CollisionAlertLevel>;
  footprintByDevice: Record<string, string>;
  routeStateByDevice: Record<string, RouteState>;
  activeSilentNotices: Record<string, boolean>;
  readonly THRESHOLD_1_METERS = 80;
  readonly THRESHOLD_2_METERS = 40;
  readonly CLEAR_MARGIN = 1.15; // histeresis - evita parpadeo por ruido GPS al limpiar

  constructor({
    io,
    alertEventRepo,
    infractionRepo,
    geofenceRepo,
    socketServer,
  }: {
    io: SocketIoLike;
    alertEventRepo?: AlertEventRepoLike;
    infractionRepo?: InfractionRepoLike;
    geofenceRepo?: GeofenceRepoLike;
    socketServer?: SocketServerLike;
  }) {
    this.io = io;
    this.socketServer = socketServer || null;
    this.alertEventRepo = alertEventRepo;
    this.infractionRepo = infractionRepo;
    this.geofenceRepo = geofenceRepo;
    this.positionHistory = {};
    this.collisionAlerts = {};
    this.footprintByDevice = {};
    this.routeStateByDevice = {};
    this.activeSilentNotices = {};
  }

  // fleetState viene keyed por deviceId. Async solo por la consulta de ruta (geofenceRepo) - si no
  // se provee esa dependencia, toda la funcion corre 100% sincrona, igual que antes de esta feature
  // (los tests existentes construyen el servicio sin geofenceRepo y no esperan la promesa devuelta)
  async evaluate(
    position: EvaluatedPosition,
    fleetState: Record<string, EvaluatedPosition>,
  ): Promise<void> {
    const { deviceId } = position;
    this.updateHistory(position);

    if (position.footprintWkt) {
      this.footprintByDevice[String(deviceId)] = position.footprintWkt;
    } else {
      delete this.footprintByDevice[String(deviceId)];
    }

    const routePeerIds = new Set<string>();

    if (this.geofenceRepo) {
      const myRoute = await this._updateRouteState(position);
      if (myRoute) {
        for (const [otherId, otherRoute] of Object.entries(this.routeStateByDevice)) {
          if (otherId === String(deviceId)) continue;
          if (otherRoute.geofenceId !== myRoute.geofenceId) continue;
          const otherPos = fleetState[otherId];
          if (!otherPos) continue;
          if (!this.positionHistory[otherId] || this.positionHistory[otherId].length < 2) continue;

          routePeerIds.add(otherId);
          const sameDirection =
            myRoute.direction !== null && otherRoute.direction !== null && myRoute.direction === otherRoute.direction;
          this._evaluateRoutePair(position, otherPos, sameDirection);
        }
      }
    }

    if (!this.positionHistory[deviceId] || this.positionHistory[deviceId].length < 2) {
      return;
    }

    Object.values(fleetState).forEach((otherPos) => {
      if (otherPos.deviceId === deviceId) return;
      if (routePeerIds.has(String(otherPos.deviceId))) return; // ya se evaluo arriba con logica de ruta
      if (
        !this.positionHistory[otherPos.deviceId] ||
        this.positionHistory[otherPos.deviceId].length < 2
      )
        return;

      this.evaluatePair(position, otherPos);
    });
  }

  // ¿en que ruta esta este punto y en que direccion la esta recorriendo? null = no esta en ninguna
  // ruta ahora mismo (se limpia el estado guardado, asi un vehiculo que se sale de la ruta - ej. a
  // un estacionamiento - deja de contar para los demas de inmediato, sin alerta negativa por salir)
  async _updateRouteState(position: EvaluatedPosition): Promise<RouteState | null> {
    if (!this.geofenceRepo) return null;
    const deviceKey = String(position.deviceId);
    const match = await this.geofenceRepo.findRouteMembership({
      projectId: position.projectId ?? null,
      latitude: position.latitude,
      longitude: position.longitude,
    });

    if (!match) {
      delete this.routeStateByDevice[deviceKey];
      return null;
    }

    const prev = this.routeStateByDevice[deviceKey];
    let direction: RouteDirection = null;
    if (prev && prev.geofenceId === match.id) {
      const delta = match.lineFraction - prev.fraction;
      direction = Math.abs(delta) > ROUTE_FRACTION_DEADBAND ? (delta > 0 ? 'forward' : 'backward') : prev.direction;
    }

    const state: RouteState = {
      geofenceId: match.id,
      geofenceName: match.name,
      fraction: match.lineFraction,
      direction,
    };
    this.routeStateByDevice[deviceKey] = state;
    return state;
  }

  // par de vehiculos en la MISMA ruta - misma direccion reusa evaluatePair tal cual (identico
  // criterio/umbrales que el radar generico de siempre); direccion opuesta (o alguno con direccion
  // todavia desconocida) nunca escala mas alla del aviso silencioso, salvo contacto real
  _evaluateRoutePair(pos1: EvaluatedPosition, pos2: EvaluatedPosition, sameDirection: boolean): void {
    if (sameDirection) {
      this.evaluatePair(pos1, pos2);
      return;
    }

    const pairKey = [String(pos1.deviceId), String(pos2.deviceId)].sort().join('-');
    const contact = this._footprintsOverlap(pos1.deviceId, pos2.deviceId);

    if (contact) {
      if (this.collisionAlerts[pairKey] !== 'contact') {
        this.triggerContact(pos1.deviceId, pos2.deviceId, this.calculateDistance(pos1.latitude, pos1.longitude, pos2.latitude, pos2.longitude), pos1.projectId ?? null, pos1, pos2);
      }
      this.collisionAlerts[pairKey] = 'contact';
      return;
    }

    // si ya estaba en proximity/critical (por ejemplo, cambio de direccion detectado a mitad de
    // camino) hay que bajarlo - direccion opuesta nunca debe quedarse en un nivel "molesto"
    if (this.collisionAlerts[pairKey] && this.collisionAlerts[pairKey] !== 'none') {
      this.clearAlert(pos1.deviceId, pos2.deviceId);
      this.collisionAlerts[pairKey] = 'none';
    }

    const distance = this.calculateDistance(pos1.latitude, pos1.longitude, pos2.latitude, pos2.longitude);
    const converging = this.areConverging(pos1.deviceId, pos2.deviceId);
    const speedMs = Math.max(pos1.speed ?? 0, pos2.speed ?? 0);
    const silentDistance = Math.max(ROUTE_SILENT_MIN_DISTANCE_M, speedMs * ROUTE_SILENT_LOOKAHEAD_SECONDS);

    if (converging && distance <= silentDistance) {
      this._sendSilentNotice(pos1.deviceId, pos2.deviceId, distance);
    } else if (this.activeSilentNotices[pairKey]) {
      this._clearSilentNotice(pos1.deviceId, pairKey);
    }
  }

  _footprintsOverlap(deviceId1: EvaluatedPosition['deviceId'], deviceId2: EvaluatedPosition['deviceId']): boolean {
    const a = this.footprintByDevice[String(deviceId1)];
    const b = this.footprintByDevice[String(deviceId2)];
    if (!a || !b) return false;
    try {
      return footprintsOverlap(a, b);
    } catch {
      return false; // WKT invalido/incompleto - nunca reventar la evaluacion por esto
    }
  }

  // aviso silencioso - SOLO al operador de pos1 (sendToDevice), nunca se guarda. Se manda desde la
  // perspectiva de CADA dispositivo por separado (si A ve a B, B tambien ve a A en su propia
  // evaluacion) - igual de deliberado que el resto del sistema elastico, cada quien recibe su propio
  // aviso en primera persona.
  _sendSilentNotice(deviceId: EvaluatedPosition['deviceId'], otherDeviceId: EvaluatedPosition['deviceId'], distanceMeters: number): void {
    const pairKey = [String(deviceId), String(otherDeviceId)].sort().join('-');
    this.activeSilentNotices[pairKey] = true;
    if (!this.socketServer) return;
    this.socketServer.sendToDevice(String(deviceId), 'alert:proximity_notice', {
      deviceId: String(deviceId),
      otherDeviceId: String(otherDeviceId),
      distanceMeters: Math.round(distanceMeters),
      message: `Precaución - vehículo cercano en tu ruta (${Math.round(distanceMeters)} m)`,
      timestamp: new Date().toISOString(),
    });
  }

  _clearSilentNotice(deviceId: EvaluatedPosition['deviceId'], pairKey: string): void {
    this.activeSilentNotices[pairKey] = false;
    if (!this.socketServer) return;
    this.socketServer.sendToDevice(String(deviceId), 'alert:proximity_clear', {
      deviceId: String(deviceId),
      timestamp: new Date().toISOString(),
    });
  }

  updateHistory(position: EvaluatedPosition): void {
    const { deviceId } = position;

    if (!this.positionHistory[deviceId]) {
      this.positionHistory[deviceId] = [];
    }

    this.positionHistory[deviceId].push({
      lat: position.latitude,
      lon: position.longitude,
      timestamp: Date.now(),
    });

    if (this.positionHistory[deviceId].length > 5) {
      this.positionHistory[deviceId].shift();
    }
  }

  // camino generico de siempre ("toda el area") - SIN CAMBIOS de comportamiento salvo la deteccion
  // de contacto real (nueva, aplica sin importar ruta) y que critical/contact ahora ademas crean
  // una infraccion permanente
  evaluatePair(pos1: EvaluatedPosition, pos2: EvaluatedPosition): void {
    // deviceId es string - sort+join evita el bug viejo de Math.min devolviendo NaN
    const pairKey = [String(pos1.deviceId), String(pos2.deviceId)].sort().join('-');

    const distance = this.calculateDistance(
      pos1.latitude,
      pos1.longitude,
      pos2.latitude,
      pos2.longitude,
    );

    const contact = this._footprintsOverlap(pos1.deviceId, pos2.deviceId);
    const currentAlert = this.collisionAlerts[pairKey] || 'none';

    if (contact) {
      if (currentAlert !== 'contact') {
        this.triggerContact(pos1.deviceId, pos2.deviceId, distance, pos1.projectId ?? null, pos1, pos2);
      }
      this.collisionAlerts[pairKey] = 'contact';
      return;
    }

    const converging = this.areConverging(pos1.deviceId, pos2.deviceId);

    if (distance <= this.THRESHOLD_2_METERS && converging) {
      if (currentAlert !== 'critical') {
        this.triggerCritical(pos1.deviceId, pos2.deviceId, distance, pos1.projectId ?? null, pos1, pos2);
      }
      this.collisionAlerts[pairKey] = 'critical';
    } else if (distance <= this.THRESHOLD_1_METERS && converging && currentAlert === 'none') {
      this.triggerProximity(pos1.deviceId, pos2.deviceId, distance);
      this.collisionAlerts[pairKey] = 'proximity';
    } else if (currentAlert !== 'none' && distance > this.THRESHOLD_1_METERS * this.CLEAR_MARGIN) {
      this.clearCollisionAlert(pos1.deviceId, pos2.deviceId);
      this.collisionAlerts[pairKey] = 'none';
    }
  }

  areConverging(deviceId1: EvaluatedPosition['deviceId'], deviceId2: EvaluatedPosition['deviceId']): boolean {
    const history1 = this.positionHistory[deviceId1];
    const history2 = this.positionHistory[deviceId2];

    if (!history1 || history1.length < 2) return false;
    if (!history2 || history2.length < 2) return false;

    const currentDist = this.calculateDistance(
      history1[history1.length - 1].lat,
      history1[history1.length - 1].lon,
      history2[history2.length - 1].lat,
      history2[history2.length - 1].lon,
    );

    const previousDist = this.calculateDistance(
      history1[history1.length - 2].lat,
      history1[history1.length - 2].lon,
      history2[history2.length - 2].lat,
      history2[history2.length - 2].lon,
    );

    return currentDist < previousDist;
  }

  triggerProximity(deviceId1: EvaluatedPosition['deviceId'], deviceId2: EvaluatedPosition['deviceId'], distance: number): void {
    console.log(
      ` PROXIMIDAD - Vehículos ${deviceId1} y ${deviceId2} a ${Math.round(distance)}m convergiendo`,
    );

    const payload = {
      type: 'collision_proximity',
      deviceId1,
      deviceId2,
      distance: Math.round(distance),
      message: `PRECAUCIÓN - VEHÍCULOS ${deviceId1} Y ${deviceId2} A ${Math.round(distance)} METROS - REDUZCA VELOCIDAD`,
      timestamp: new Date().toISOString(),
    };

    this.io.emit('collision:proximity', payload);
    this.io.emit('supervisor:collision', { ...payload, level: 1 });
    this._recordAlertEvent(deviceId1, deviceId2, 'warning', payload.message, {
      distance: payload.distance,
    });
  }

  triggerCritical(
    deviceId1: EvaluatedPosition['deviceId'],
    deviceId2: EvaluatedPosition['deviceId'],
    distance: number,
    projectId: number | null,
    pos1?: EvaluatedPosition,
    pos2?: EvaluatedPosition,
  ): void {
    console.log(
      `COLISIÓN INMINENTE - Vehículos ${deviceId1} y ${deviceId2} a ${Math.round(distance)}m`,
    );

    const payload = {
      type: 'collision_critical',
      deviceId1,
      deviceId2,
      distance: Math.round(distance),
      message: `PELIGRO - COLISIÓN INMINENTE ENTRE ${deviceId1} Y ${deviceId2} - DETÉNGANSE INMEDIATAMENTE`,
      loop: true,
      timestamp: new Date().toISOString(),
    };

    this.io.emit('collision:critical', payload);
    this.io.emit('supervisor:collision', { ...payload, level: 2 });

    this._recordAlertEvent(deviceId1, deviceId2, 'danger', payload.message, {
      distance: payload.distance,
    });

    const combinedSpeedKmh = ((pos1?.speed ?? 0) + (pos2?.speed ?? 0)) * 3.6;
    this._recordInfraction(deviceId1, deviceId2, payload.message, distance, projectId, pos1, 'critical', combinedSpeedKmh);
  }

  // "choque realizado" - las siluetas reales ya se tocan, sin importar direccion/ruta. Mas grave que
  // "critical" (que es solo convergencia muy cercana, todavia sin contacto)
  triggerContact(
    deviceId1: EvaluatedPosition['deviceId'],
    deviceId2: EvaluatedPosition['deviceId'],
    distance: number,
    projectId: number | null,
    pos1?: EvaluatedPosition,
    pos2?: EvaluatedPosition,
  ): void {
    console.log(`COLISIÓN REAL - Vehículos ${deviceId1} y ${deviceId2} en contacto`);

    const payload = {
      type: 'collision_critical',
      deviceId1,
      deviceId2,
      distance: Math.round(distance),
      message: `COLISIÓN - VEHÍCULOS ${deviceId1} Y ${deviceId2} EN CONTACTO - DETENGA OPERACIONES Y REPORTE DE INMEDIATO`,
      loop: true,
      timestamp: new Date().toISOString(),
    };

    this.io.emit('collision:critical', payload);
    this.io.emit('supervisor:collision', { ...payload, level: 2 });

    this._recordAlertEvent(deviceId1, deviceId2, 'danger', payload.message, {
      distance: payload.distance,
      contact: true,
    });

    const combinedSpeedKmh = ((pos1?.speed ?? 0) + (pos2?.speed ?? 0)) * 3.6;
    this._recordInfraction(deviceId1, deviceId2, payload.message, distance, projectId, pos1, 'contact', combinedSpeedKmh);
  }

  clearCollisionAlert(deviceId1: EvaluatedPosition['deviceId'], deviceId2: EvaluatedPosition['deviceId']): void {
    this.clearAlert(deviceId1, deviceId2);
  }

  clearAlert(deviceId1: EvaluatedPosition['deviceId'], deviceId2: EvaluatedPosition['deviceId']): void {
    console.log(`Vehículos ${deviceId1} y ${deviceId2} ya no están en riesgo de colisión`);

    const timestamp = new Date().toISOString();
    this.io.emit('collision:clear', { deviceId1, deviceId2, timestamp });
    this.io.emit('supervisor:collision', { deviceId1, deviceId2, level: 0, timestamp });

    this._resolveAlertEvent(deviceId1, deviceId2);
  }

  _recordAlertEvent(
    deviceId1: EvaluatedPosition['deviceId'],
    deviceId2: EvaluatedPosition['deviceId'],
    severity: 'warning' | 'danger',
    message: string,
    metadata: Record<string, unknown>,
  ): void {
    if (!this.alertEventRepo) return;
    const [a, b] = [String(deviceId1), String(deviceId2)].sort();
    this.alertEventRepo
      .recordOrEscalate({ alertType: 'collision', severity, deviceId: a, deviceId2: b, message, metadata })
      .catch((err: Error) => console.error('CollisionRiskService._recordAlertEvent:', err.message));
  }

  _resolveAlertEvent(deviceId1: EvaluatedPosition['deviceId'], deviceId2: EvaluatedPosition['deviceId']): void {
    if (!this.alertEventRepo) return;
    const [a, b] = [String(deviceId1), String(deviceId2)].sort();
    this.alertEventRepo
      .resolveOpen({ alertType: 'collision', deviceId: a, deviceId2: b })
      .catch((err: Error) => console.error('CollisionRiskService._resolveAlertEvent:', err.message));
  }

  _recordInfraction(
    deviceId1: EvaluatedPosition['deviceId'],
    deviceId2: EvaluatedPosition['deviceId'],
    message: string,
    distanceMeters: number,
    projectId: number | null,
    pos1: EvaluatedPosition | undefined,
    kind: 'critical' | 'contact',
    combinedSpeedKmh: number,
  ): void {
    if (!this.infractionRepo || !pos1) return;
    const [a, b] = [String(deviceId1), String(deviceId2)].sort();
    this.infractionRepo
      .create({
        projectId,
        deviceId: a,
        deviceId2: b,
        infractionType: 'collision',
        severity: collisionInfractionSeverity(kind, combinedSpeedKmh),
        message,
        latitude: pos1.latitude,
        longitude: pos1.longitude,
        metadata: { distanceMeters: Math.round(distanceMeters), kind, combinedSpeedKmh: Math.round(combinedSpeedKmh) },
      })
      .catch((err: Error) => console.error('CollisionRiskService._recordInfraction:', err.message));
  }

  calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  toRad(deg: number): number {
    return deg * (Math.PI / 180);
  }

  clearDevice(deviceId: string, otherDeviceIds: string[]): void {
    otherDeviceIds.forEach((otherId) => {
      const pairKey = [deviceId, otherId].sort().join('-');
      const currentAlert = this.collisionAlerts[pairKey];
      if (currentAlert && currentAlert !== 'none') {
        this.clearAlert(deviceId, otherId);
      }
      delete this.collisionAlerts[pairKey];
      delete this.activeSilentNotices[pairKey];
    });
    delete this.positionHistory[deviceId];
    delete this.footprintByDevice[deviceId];
    delete this.routeStateByDevice[deviceId];
  }
}

export default CollisionRiskService;
