/**
 * StaticEquipmentManager.js
 *
 * Responsabilidad: Gestionar equipos estáticos con radio
 * de giro activo (palas, excavadoras, cargadores) y
 * guiar la aproximación de vehículos hacia ellos.
 *
 * RF asociados: RF-ALR-12
 */

class StaticEquipmentManager {

  constructor({ io }) {
    this.io = io;
    // Equipos estáticos registrados
    this.equipment = {};
    // Estado de aproximación por par vehiculo-equipo
    this.approachState = {};
  }

  /**
   * Registra un equipo estático en el sistema
   * @param {Object} eq - {
   *   id, name, type,
   *   lat, lon,
   *   swingRadius,    radio de giro del brazo en metros
   *   safetyRadius,   distancia mínima segura en metros
   *   status          'active_swing' | 'active_pause' | 'inactive'
   * }
   */
  registerEquipment(eq) {
    this.equipment[eq.id] = { ...eq };
    console.log(`🏗️  Equipo estático registrado: ${eq.name} | Radio giro: ${eq.swingRadius}m | Radio seguridad: ${eq.safetyRadius}m`);
  }

  /**
   * Actualiza el estado operativo de un equipo
   * active_swing  → brazo girando — máximo peligro
   * active_pause  → brazo detenido — umbrales reducidos al 60%
   * inactive      → fuera de turno — sin restricciones
   */
  updateStatus(equipmentId, status) {
    if (this.equipment[equipmentId]) {
      this.equipment[equipmentId].status = status;
      console.log(`🏗️  Equipo ${equipmentId} estado actualizado: ${status}`);

      // Notificar a todos los clientes
      this.io.emit('equipment:status_update', {
        equipmentId,
        status,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Evalúa la posición de un vehículo respecto a todos
   * los equipos estáticos activos
   */
  evaluate(position) {
    const { deviceId, latitude, longitude } = position;

    Object.values(this.equipment).forEach(eq => {
      if (eq.status === 'inactive') return;

      const distance = this.calculateDistance(
        latitude, longitude,
        eq.lat, eq.lon
      );

      // Ajustar umbrales según estado del equipo
      const factor = eq.status === 'active_pause' ? 0.6 : 1.0;
      const outerZone = 50 * factor;           // Zona exterior
      const innerZone = eq.safetyRadius * 2 * factor;  // Zona interior
      const minDistance = eq.safetyRadius * factor;     // Límite mínimo

      const pairKey = `${deviceId}-${eq.id}`;
      const currentState = this.approachState[pairKey] || 'clear';

      if (distance <= minDistance) {
        // Límite mínimo alcanzado — detener vehículo
        if (currentState !== 'minimum') {
          this.triggerMinimumLimit(deviceId, eq, distance);
          this.approachState[pairKey] = 'minimum';
        }

      } else if (distance <= innerZone) {
        // Zona interior — aproximación lenta
        if (currentState !== 'inner' && currentState !== 'minimum') {
          this.triggerInnerZone(deviceId, eq, distance);
          this.approachState[pairKey] = 'inner';
        } else if (currentState === 'inner') {
          // Actualizar distancia en tiempo real
          this.updateApproachDistance(deviceId, eq, distance);
        }

      } else if (distance <= outerZone) {
        // Zona exterior — iniciar guía de aproximación
        if (currentState === 'clear') {
          this.triggerOuterZone(deviceId, eq, distance);
          this.approachState[pairKey] = 'outer';
        } else if (currentState === 'outer') {
          this.updateApproachDistance(deviceId, eq, distance);
        }

      } else {
        // Fuera de todas las zonas
        if (currentState !== 'clear') {
          this.clearApproach(deviceId, eq);
          this.approachState[pairKey] = 'clear';
        }
      }
    });
  }

  triggerOuterZone(deviceId, eq, distance) {
    console.log(`🏗️  ZONA EXTERIOR — Device ${deviceId} a ${Math.round(distance)}m de ${eq.name}`);

    this.io.emit('equipment:approach_outer', {
      deviceId,
      equipmentId: eq.id,
      equipmentName: eq.name,
      distance: Math.round(distance),
      message: `APROXIMACIÓN A ${eq.name.toUpperCase()} — REDUZCA VELOCIDAD Y ESPERE GUÍA`,
      timestamp: new Date().toISOString()
    });
  }

  triggerInnerZone(deviceId, eq, distance) {
    console.log(`🏗️  ZONA INTERIOR — Device ${deviceId} a ${Math.round(distance)}m de ${eq.name}`);

    this.io.emit('equipment:approach_inner', {
      deviceId,
      equipmentId: eq.id,
      equipmentName: eq.name,
      distance: Math.round(distance),
      message: `ACÉRQUESE LENTAMENTE — DISTANCIA AL EQUIPO: ${Math.round(distance)}m`,
      timestamp: new Date().toISOString()
    });

    // Notificar al operador del equipo estático
    this.io.emit('equipment:vehicle_approaching', {
      equipmentId: eq.id,
      deviceId,
      distance: Math.round(distance),
      timestamp: new Date().toISOString()
    });
  }

  triggerMinimumLimit(deviceId, eq, distance) {
    console.log(`🚨 LÍMITE MÍNIMO — Device ${deviceId} a ${Math.round(distance)}m de ${eq.name}`);

    this.io.emit('equipment:minimum_limit', {
      deviceId,
      equipmentId: eq.id,
      equipmentName: eq.name,
      distance: Math.round(distance),
      message: `DISTANCIA MÍNIMA ALCANZADA — DETENGA EL VEHÍCULO`,
      loop: true,
      timestamp: new Date().toISOString()
    });
  }

  updateApproachDistance(deviceId, eq, distance) {
    this.io.emit('equipment:distance_update', {
      deviceId,
      equipmentId: eq.id,
      distance: Math.round(distance),
      timestamp: new Date().toISOString()
    });
  }

  clearApproach(deviceId, eq) {
    console.log(`✅ Device ${deviceId} salió de zona de ${eq.name}`);

    this.io.emit('equipment:approach_clear', {
      deviceId,
      equipmentId: eq.id,
      timestamp: new Date().toISOString()
    });
  }

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

module.exports = StaticEquipmentManager;