/**
 * GeofenceAlertService.js
 *
 * Responsabilidad: Evaluar si un vehículo está dentro
 * de una geocerca y emitir alertas al dispositivo
 * correspondiente y al panel de supervisor.
 *
 * RF asociados: RF-ALR-02 (zona amarilla)
 *               RF-ALR-03 (zona roja)
 *               RF-ALR-04 (notificación a supervisor)
 */

class GeofenceAlertService {

  constructor({ io }) {
    this.io = io;
    // Geocercas activas en memoria
    // En producción vendrán de PostgreSQL
    this.activeGeofences = [];
    // Estado de alertas activas por dispositivo
    this.activeAlerts = {};
  }

  /**
   * Agrega o actualiza una geocerca activa
   * @param {Object} geofence - { id, name, type, center, radiusMeters }
   * type: 'warning' (amarilla) o 'danger' (roja)
   */
  addGeofence(geofence) {
    const existing = this.activeGeofences.findIndex(g => g.id === geofence.id);
    if (existing >= 0) {
      this.activeGeofences[existing] = geofence;
    } else {
      this.activeGeofences.push(geofence);
    }
    console.log(`Geocerca registrada: ${geofence.name} (${geofence.type}) — Radio: ${geofence.radiusMeters}m`);
  }

  /**
   * Elimina una geocerca por ID
   */
  removeGeofence(id) {
    this.activeGeofences = this.activeGeofences.filter(g => g.id !== id);
  }

  /**
   * Evalúa la posición de un vehículo contra todas las geocercas activas
   * Se llama cada vez que llega una posición nueva de un vehículo
   *
   * @param {Object} position - posición del vehículo desde Traccar
   */
  evaluate(position) {
    const { deviceId, latitude, longitude } = position;

    let maxSeverity = null; // null | 'warning' | 'danger'
    let triggeredGeofence = null;

    // Evaluar contra cada geocerca activa
    for (const geofence of this.activeGeofences) {
      const distance = this.calculateDistance(
        latitude, longitude,
        geofence.center.lat, geofence.center.lon
      );

      if (distance <= geofence.radiusMeters) {
        // Vehículo dentro de esta geocerca
        // 'danger' tiene prioridad sobre 'warning'
        if (geofence.type === 'danger') {
          maxSeverity = 'danger';
          triggeredGeofence = geofence;
          break; // danger es máxima prioridad, no seguir evaluando
        } else if (geofence.type === 'warning' && maxSeverity !== 'danger') {
          maxSeverity = 'warning';
          triggeredGeofence = geofence;
        }
      }
    }

    // Comparar con estado anterior para detectar cambios
    const previousAlert = this.activeAlerts[deviceId];

    if (maxSeverity && maxSeverity !== previousAlert) {
      // Vehículo entró a zona de alerta o escaló de nivel
      this.triggerAlert(deviceId, maxSeverity, triggeredGeofence);
      this.activeAlerts[deviceId] = maxSeverity;

    } else if (!maxSeverity && previousAlert) {
      // Vehículo salió de todas las geocercas
      this.clearAlert(deviceId);
      this.activeAlerts[deviceId] = null;
    }
  }

  /**
   * Activa alerta en el dispositivo y notifica al supervisor
   */
  triggerAlert(deviceId, severity, geofence) {

    const messages = {
      warning: 'PRECAUCIÓN — ZONA DE RIESGO — REDUCIR VELOCIDAD',
      danger:  'PELIGRO — DETENER VEHÍCULO INMEDIATAMENTE'
    };

    const alertPayload = {
      type: severity === 'danger' ? 'geofence_red' : 'geofence_yellow',
      deviceId,
      geofenceName: geofence.name,
      message: messages[severity],
      loop: severity === 'danger', // sirena en bucle para zona roja
      timestamp: new Date().toISOString()
    };

    console.log(`🚨 ALERTA ${severity.toUpperCase()} — Device: ${deviceId} | Geocerca: ${geofence.name}`);

    // Emitir al dispositivo específico
    // En producción usaremos rooms por deviceId
    if (severity === 'danger') {
      this.io.emit('alert:critical', alertPayload);
    } else {
      this.io.emit('alert:warning', alertPayload);
    }

    // Notificar al panel de supervisor
    this.io.emit('supervisor:alert', {
      ...alertPayload,
      action: 'entered'
    });
  }

  /**
   * Cancela alertas activas cuando el vehículo sale de la geocerca
   */
  clearAlert(deviceId) {
    console.log(`✅ Device ${deviceId} salió de la geocerca — cancelando alertas`);

    this.io.emit('alert:clear', {
      deviceId,
      timestamp: new Date().toISOString()
    });

    this.io.emit('supervisor:alert', {
      deviceId,
      action: 'exited',
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Calcula distancia en metros entre dos coordenadas
   * Fórmula de Haversine
   *
   * @returns {number} distancia en metros
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Radio de la Tierra en metros
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

  /**
   * Retorna el estado actual de alertas activas
   * para enviar a clientes que se conectan tarde
   */
  getActiveAlerts() {
    return this.activeAlerts;
  }
}

module.exports = GeofenceAlertService;