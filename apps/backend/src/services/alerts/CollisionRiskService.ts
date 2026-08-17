/**
 * CollisionRiskService.ts
 *
 * Responsabilidad: Detectar riesgo de colisión entre
 * vehículos usando distancia actual y trayectoria proyectada.
 *
 * Umbral 1 - 80 metros con trayectorias convergentes:
 *   Alerta de proximidad en ambos dispositivos
 *
 * Umbral 2 - 40 metros con trayectorias convergentes:
 *   Alerta crítica de colisión inminente
 *
 * RF asociados: RF-ALR-10
 */

interface SocketIoLike {
  emit(event: string, payload: unknown): void;
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

interface EvaluatedPosition {
  deviceId: number;
  latitude: number;
  longitude: number;
}

interface HistoryPoint {
  lat: number;
  lon: number;
  timestamp: number;
}

type CollisionAlertLevel = 'none' | 'proximity' | 'critical';

class CollisionRiskService {
  io: SocketIoLike;
  alertEventRepo?: AlertEventRepoLike;
  positionHistory: Record<number, HistoryPoint[]>;
  collisionAlerts: Record<string, CollisionAlertLevel>;
  readonly THRESHOLD_1_METERS = 80;
  readonly THRESHOLD_2_METERS = 40;
  // Histéresis de limpieza - evita parpadeo por jitter de GPS en
  // vehículos casi estáticos (ver areConverging).
  readonly CLEAR_MARGIN = 1.15;

  constructor({ io, alertEventRepo }: { io: SocketIoLike; alertEventRepo?: AlertEventRepoLike }) {
    this.io = io;
    this.alertEventRepo = alertEventRepo;

    // Historial de posiciones por dispositivo (últimas 5)
    this.positionHistory = {};

    // Estado de alerta de colisión por par - clave: IDs ordenados como texto
    this.collisionAlerts = {};
  }

  /**
   * Registra nueva posición y evalúa riesgo de colisión
   * contra todos los demás vehículos activos
   *
   * @param fleetState - estado actual de toda la flota, keyed por deviceId
   */
  evaluate(position: EvaluatedPosition, fleetState: Record<string, EvaluatedPosition>): void {
    const { deviceId } = position;

    // Actualizar historial de posiciones
    this.updateHistory(position);

    // Necesitamos al menos 2 posiciones en historial para calcular trayectoria
    if (!this.positionHistory[deviceId] || this.positionHistory[deviceId].length < 2) {
      return;
    }

    // Evaluar contra cada otro vehículo activo
    Object.values(fleetState).forEach((otherPos) => {
      if (otherPos.deviceId === deviceId) return;
      if (
        !this.positionHistory[otherPos.deviceId] ||
        this.positionHistory[otherPos.deviceId].length < 2
      )
        return;

      this.evaluatePair(position, otherPos);
    });
  }

  /**
   * Actualiza el historial de las últimas 5 posiciones
   */
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

    // Mantener solo las últimas 5 posiciones
    if (this.positionHistory[deviceId].length > 5) {
      this.positionHistory[deviceId].shift();
    }
  }

  /**
   * Evalúa el riesgo de colisión entre dos vehículos específicos
   */
  evaluatePair(pos1: EvaluatedPosition, pos2: EvaluatedPosition): void {
    // deviceId es un unique_id de texto (ej. "CAMION-01") aunque el
    // tipo diga number - Math.min/Math.max daría NaN para ambos y
    // colapsaría todos los pares en una sola llave.
    const pairKey = [String(pos1.deviceId), String(pos2.deviceId)].sort().join('-');

    // Calcular distancia actual entre ambos vehículos
    const distance = this.calculateDistance(
      pos1.latitude,
      pos1.longitude,
      pos2.latitude,
      pos2.longitude,
    );

    // Calcular si las trayectorias convergen
    const converging = this.areConverging(pos1.deviceId, pos2.deviceId);

    const currentAlert = this.collisionAlerts[pairKey] || 'none';

    if (distance <= this.THRESHOLD_2_METERS && converging) {
      // Umbral 2 - Colisión inminente
      if (currentAlert !== 'critical') {
        this.triggerCritical(pos1.deviceId, pos2.deviceId, distance);
      }
      this.collisionAlerts[pairKey] = 'critical';
    } else if (distance <= this.THRESHOLD_1_METERS && converging && currentAlert === 'none') {
      // Umbral 1 - Proximidad con convergencia
      this.triggerProximity(pos1.deviceId, pos2.deviceId, distance);
      this.collisionAlerts[pairKey] = 'proximity';
    } else if (currentAlert !== 'none' && distance > this.THRESHOLD_1_METERS * this.CLEAR_MARGIN) {
      // Solo se limpia cuando la distancia realmente creció más allá
      // del umbral (con margen) - no por un solo tick sin
      // convergencia, que puede ser ruido de GPS.
      this.clearCollisionAlert(pos1.deviceId, pos2.deviceId);
      this.collisionAlerts[pairKey] = 'none';
    }
    // Ningún caso: se mantiene el estado actual (p. ej. "critical"
    // con la distancia todavía peligrosa pero sin convergencia en
    // este tick puntual).
  }

  /**
   * Determina si dos vehículos tienen trayectorias convergentes
   * Compara la distancia actual vs la distancia hace 2 posiciones
   * Si la distancia está disminuyendo = convergentes
   *
   * RF-ALR-10 - cálculo de trayectoria con últimas 5 posiciones
   */
  areConverging(deviceId1: number, deviceId2: number): boolean {
    const history1 = this.positionHistory[deviceId1];
    const history2 = this.positionHistory[deviceId2];

    if (!history1 || history1.length < 2) return false;
    if (!history2 || history2.length < 2) return false;

    // Distancia actual (últimas posiciones)
    const currentDist = this.calculateDistance(
      history1[history1.length - 1].lat,
      history1[history1.length - 1].lon,
      history2[history2.length - 1].lat,
      history2[history2.length - 1].lon,
    );

    // Distancia anterior (penúltimas posiciones)
    const previousDist = this.calculateDistance(
      history1[history1.length - 2].lat,
      history1[history1.length - 2].lon,
      history2[history2.length - 2].lat,
      history2[history2.length - 2].lon,
    );

    // Si la distancia actual es menor que la anterior = convergentes
    return currentDist < previousDist;
  }

  /**
   * Umbral 1 - Alerta de proximidad con convergencia
   */
  triggerProximity(deviceId1: number, deviceId2: number, distance: number): void {
    console.log(
      ` PROXIMIDAD - Vehículos ${deviceId1} y ${deviceId2} a ${Math.round(distance)}m convergiendo`,
    );

    const payload = {
      type: 'collision_proximity',
      deviceId1,
      deviceId2,
      distance: Math.round(distance),
      message: `PRECAUCIÓN - VEHÍCULO ${deviceId2} A ${Math.round(distance)} METROS - REDUZCA VELOCIDAD`,
      timestamp: new Date().toISOString(),
    };

    // Alertar a ambos vehículos
    this.io.emit('collision:proximity', payload);

    // Notificar al supervisor
    this.io.emit('supervisor:collision', { ...payload, level: 1 });

    this._recordAlertEvent(deviceId1, deviceId2, 'warning', payload.message, {
      distance: payload.distance,
    });
  }

  /**
   * Umbral 2 - Colisión inminente
   */
  triggerCritical(deviceId1: number, deviceId2: number, distance: number): void {
    console.log(
      `COLISIÓN INMINENTE - Vehículos ${deviceId1} y ${deviceId2} a ${Math.round(distance)}m`,
    );

    const payload = {
      type: 'collision_critical',
      deviceId1,
      deviceId2,
      distance: Math.round(distance),
      message: `PELIGRO - COLISIÓN INMINENTE CON VEHÍCULO - DETÉNGASE INMEDIATAMENTE`,
      loop: true,
      timestamp: new Date().toISOString(),
    };

    // Alerta crítica a ambos vehículos
    this.io.emit('collision:critical', payload);

    // Notificar al supervisor
    this.io.emit('supervisor:collision', { ...payload, level: 2 });

    this._recordAlertEvent(deviceId1, deviceId2, 'danger', payload.message, {
      distance: payload.distance,
    });
  }

  /**
   * Cancelar alerta de colisión cuando los vehículos se separan
   */
  clearCollisionAlert(deviceId1: number, deviceId2: number): void {
    console.log(`Vehículos ${deviceId1} y ${deviceId2} ya no están en riesgo de colisión`);

    const timestamp = new Date().toISOString();
    this.io.emit('collision:clear', { deviceId1, deviceId2, timestamp });
    this.io.emit('supervisor:collision', { deviceId1, deviceId2, level: 0, timestamp });

    this._resolveAlertEvent(deviceId1, deviceId2);
  }

  /**
   * Historial unificado de alertas (ver alert_events) -
   * fire-and-forget. `deviceId1`/`deviceId2` llegan tipados `number`
   * pero en runtime son texto ("CAMION-01") - mismo bug de tipo ya
   * documentado en CLAUDE.md para la clave de deduplicación; se
   * envuelven con `String(...)` aquí por la misma razón.
   */
  _recordAlertEvent(
    deviceId1: number,
    deviceId2: number,
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

  _resolveAlertEvent(deviceId1: number, deviceId2: number): void {
    if (!this.alertEventRepo) return;
    const [a, b] = [String(deviceId1), String(deviceId2)].sort();
    this.alertEventRepo
      .resolveOpen({ alertType: 'collision', deviceId: a, deviceId2: b })
      .catch((err: Error) => console.error('CollisionRiskService._resolveAlertEvent:', err.message));
  }

  /**
   * Fórmula de Haversine - distancia en metros
   */
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

  /**
   * Limpia el estado de un dispositivo eliminado - evita que un par
   * con alerta activa quede fantasma en `collisionAlerts` para
   * siempre (`evaluatePair` solo limpia cuando ambos vehículos
   * siguen reportando posición, y uno de los dos ya no existe).
   *
   * `otherDeviceIds` lo arma el caller (todos los demás dispositivos
   * conocidos en ese momento) porque `pairKey` no se puede parsear de
   * vuelta a los dos IDs originales de forma confiable - son texto
   * libre y pueden contener guiones (ej. "CAMION-01"), así que en vez
   * de intentar separar el string se reconstruye el pairKey candidato
   * contra cada otro dispositivo y se revisa si existe.
   */
  clearDevice(deviceId: string, otherDeviceIds: string[]): void {
    otherDeviceIds.forEach((otherId) => {
      const pairKey = [deviceId, otherId].sort().join('-');
      const currentAlert = this.collisionAlerts[pairKey];
      if (currentAlert && currentAlert !== 'none') {
        this.clearCollisionAlert(deviceId as unknown as number, otherId as unknown as number);
      }
      delete this.collisionAlerts[pairKey];
    });
    delete this.positionHistory[deviceId as unknown as number];
  }
}

export default CollisionRiskService;
