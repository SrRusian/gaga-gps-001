/**
 * CollisionRiskService.js
 *
 * Responsabilidad: Detectar riesgo de colisión entre
 * vehículos usando distancia actual y trayectoria proyectada.
 *
 * Umbral 1 — 80 metros con trayectorias convergentes:
 *   Alerta de proximidad en ambos dispositivos
 *
 * Umbral 2 — 40 metros con trayectorias convergentes:
 *   Alerta crítica de colisión inminente
 *
 * RF asociados: RF-ALR-10
 */

class CollisionRiskService {

  constructor({ io }) {
    this.io = io;

    // Historial de posiciones por dispositivo (últimas 5)
    this.positionHistory = {};

    // Estado de alerta de colisión por par de vehículos
    // clave: "deviceId1-deviceId2" (siempre menor-mayor)
    this.collisionAlerts = {};

    // Umbrales configurables en metros
    this.THRESHOLD_1_METERS = 80;  // Alerta de proximidad
    this.THRESHOLD_2_METERS = 40;  // Colisión inminente
  }

  /**
   * Registra nueva posición y evalúa riesgo de colisión
   * contra todos los demás vehículos activos
   *
   * @param {Object} position - posición del vehículo
   * @param {Object} fleetState - estado actual de toda la flota
   */
  evaluate(position, fleetState) {
    const { deviceId } = position;

    // Actualizar historial de posiciones
    this.updateHistory(position);

    // Necesitamos al menos 2 posiciones en historial para calcular trayectoria
    if (!this.positionHistory[deviceId] ||
        this.positionHistory[deviceId].length < 2) {
      return;
    }

    // Evaluar contra cada otro vehículo activo
    Object.values(fleetState).forEach(otherPos => {
      if (otherPos.deviceId === deviceId) return;
      if (!this.positionHistory[otherPos.deviceId] ||
          this.positionHistory[otherPos.deviceId].length < 2) return;

      this.evaluatePair(position, otherPos);
    });
  }

  /**
   * Actualiza el historial de las últimas 5 posiciones
   */
  updateHistory(position) {
    const { deviceId } = position;

    if (!this.positionHistory[deviceId]) {
      this.positionHistory[deviceId] = [];
    }

    this.positionHistory[deviceId].push({
      lat: position.latitude,
      lon: position.longitude,
      timestamp: Date.now()
    });

    // Mantener solo las últimas 5 posiciones
    if (this.positionHistory[deviceId].length > 5) {
      this.positionHistory[deviceId].shift();
    }
  }

  /**
   * Evalúa el riesgo de colisión entre dos vehículos específicos
   */
  evaluatePair(pos1, pos2) {
    const id1 = Math.min(pos1.deviceId, pos2.deviceId);
    const id2 = Math.max(pos1.deviceId, pos2.deviceId);
    const pairKey = `${id1}-${id2}`;

    // Calcular distancia actual entre ambos vehículos
    const distance = this.calculateDistance(
      pos1.latitude, pos1.longitude,
      pos2.latitude, pos2.longitude
    );

    // Calcular si las trayectorias convergen
    const converging = this.areConverging(pos1.deviceId, pos2.deviceId);

    const currentAlert = this.collisionAlerts[pairKey] || 'none';

    if (distance <= this.THRESHOLD_2_METERS && converging) {
      // Umbral 2 — Colisión inminente
      if (currentAlert !== 'critical') {
        this.triggerCritical(pos1.deviceId, pos2.deviceId, distance);
        this.collisionAlerts[pairKey] = 'critical';
      }

    } else if (distance <= this.THRESHOLD_1_METERS && converging) {
      // Umbral 1 — Proximidad con convergencia
      if (currentAlert === 'none') {
        this.triggerProximity(pos1.deviceId, pos2.deviceId, distance);
        this.collisionAlerts[pairKey] = 'proximity';
      }

    } else {
      // Fuera de umbrales o trayectorias no convergentes
      if (currentAlert !== 'none') {
        this.clearCollisionAlert(pos1.deviceId, pos2.deviceId);
        this.collisionAlerts[pairKey] = 'none';
      }
    }
  }

  /**
   * Determina si dos vehículos tienen trayectorias convergentes
   * Compara la distancia actual vs la distancia hace 2 posiciones
   * Si la distancia está disminuyendo = convergentes
   *
   * RF-ALR-10 — cálculo de trayectoria con últimas 5 posiciones
   */
  areConverging(deviceId1, deviceId2) {
    const history1 = this.positionHistory[deviceId1];
    const history2 = this.positionHistory[deviceId2];

    if (!history1 || history1.length < 2) return false;
    if (!history2 || history2.length < 2) return false;

    // Distancia actual (últimas posiciones)
    const currentDist = this.calculateDistance(
      history1[history1.length - 1].lat,
      history1[history1.length - 1].lon,
      history2[history2.length - 1].lat,
      history2[history2.length - 1].lon
    );

    // Distancia anterior (penúltimas posiciones)
    const previousDist = this.calculateDistance(
      history1[history1.length - 2].lat,
      history1[history1.length - 2].lon,
      history2[history2.length - 2].lat,
      history2[history2.length - 2].lon
    );

    // Si la distancia actual es menor que la anterior = convergentes
    return currentDist < previousDist;
  }

  /**
   * Umbral 1 — Alerta de proximidad con convergencia
   */
  triggerProximity(deviceId1, deviceId2, distance) {
    console.log(`⚠️  PROXIMIDAD — Vehículos ${deviceId1} y ${deviceId2} a ${Math.round(distance)}m convergiendo`);

    const payload = {
      type: 'collision_proximity',
      deviceId1,
      deviceId2,
      distance: Math.round(distance),
      message: `PRECAUCIÓN — VEHÍCULO ${deviceId2} A ${Math.round(distance)} METROS — REDUZCA VELOCIDAD`,
      timestamp: new Date().toISOString()
    };

    // Alertar a ambos vehículos
    this.io.emit('collision:proximity', payload);

    // Notificar al supervisor
    this.io.emit('supervisor:collision', { ...payload, level: 1 });
  }

  /**
   * Umbral 2 — Colisión inminente
   */
  triggerCritical(deviceId1, deviceId2, distance) {
    console.log(`🚨 COLISIÓN INMINENTE — Vehículos ${deviceId1} y ${deviceId2} a ${Math.round(distance)}m`);

    const payload = {
      type: 'collision_critical',
      deviceId1,
      deviceId2,
      distance: Math.round(distance),
      message: `PELIGRO — COLISIÓN INMINENTE CON VEHÍCULO — DETÉNGASE INMEDIATAMENTE`,
      loop: true,
      timestamp: new Date().toISOString()
    };

    // Alerta crítica a ambos vehículos
    this.io.emit('collision:critical', payload);

    // Notificar al supervisor
    this.io.emit('supervisor:collision', { ...payload, level: 2 });
  }

  /**
   * Cancelar alerta de colisión cuando los vehículos se separan
   */
  clearCollisionAlert(deviceId1, deviceId2) {
    console.log(`✅ Vehículos ${deviceId1} y ${deviceId2} ya no están en riesgo de colisión`);

    this.io.emit('collision:clear', {
      deviceId1,
      deviceId2,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Fórmula de Haversine — distancia en metros
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  toRad(deg) {
    return deg * (Math.PI / 180);
  }
}

module.exports = CollisionRiskService;