/**
 * GeofenceAlertService.js
 *
 * Responsabilidad: Evaluar si un vehículo está dentro
 * de una geocerca y emitir alertas al dispositivo
 * correspondiente y al panel de supervisor.
 *
 * Soporta 3 formas de geocerca (círculo, polígono, polilínea/
 * corredor) — la evaluación geométrica se delega a
 * backend/src/utils/geometry.js. El comportamiento para geocercas
 * circulares es idéntico al original (misma fórmula de Haversine,
 * mismo resultado) — no se modificó esa lógica, solo se generalizó
 * para aceptar también polígonos y rutas.
 *
 * RF asociados: RF-ALR-02 (zona amarilla)
 *               RF-ALR-03 (zona roja)
 *               RF-ALR-04 (notificación a supervisor)
 */

const { isInsideGeofence } = require('../../utils/geometry');

class GeofenceAlertService {

  constructor({ io, geofenceEventRepo } = {}) {
    this.io = io;
    // Geocercas activas en memoria
    // En producción vendrán de PostgreSQL
    this.activeGeofences = [];
    // Estado de alertas activas por dispositivo
    this.activeAlerts = {};
    // Opcional — si se provee, persiste eventos de entrada/salida
    // para auditoría e historial (ver geofence_events)
    this.geofenceEventRepo = geofenceEventRepo || null;
  }

  /**
   * Agrega o actualiza una geocerca activa
   * @param {Object} geofence - { id, name, type, shapeType, center, radiusMeters, geometry, corridorWidthMeters }
   * type: 'warning' (amarilla) o 'danger' (roja)
   * shapeType: 'circle' (default) | 'polygon' | 'polyline'
   */
  addGeofence(geofence) {
    const normalized = { shapeType: 'circle', ...geofence };
    const existing = this.activeGeofences.findIndex(g => g.id === normalized.id);
    if (existing >= 0) {
      this.activeGeofences[existing] = normalized;
    } else {
      this.activeGeofences.push(normalized);
    }
    const shapeInfo = normalized.shapeType === 'circle'
      ? `Radio: ${normalized.radiusMeters}m`
      : `Forma: ${normalized.shapeType}`;
    console.log(`Geocerca registrada: ${normalized.name} (${normalized.type}) — ${shapeInfo}`);
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
   * @param {Object} position - posición del vehículo
   */
  evaluate(position) {
    const { deviceId, latitude, longitude } = position;

    let maxSeverity = null; // null | 'warning' | 'danger'
    let triggeredGeofence = null;

    // Evaluar contra cada geocerca activa — funciona igual para
    // círculo, polígono o polilínea/corredor (ver geometry.js)
    for (const geofence of this.activeGeofences) {
      const inside = isInsideGeofence(latitude, longitude, geofence);

      if (inside) {
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
      this.clearAlert(deviceId, previousAlert);
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

    this._persistEvent(deviceId, geofence.id, 'enter', severity);
  }

  /**
   * Cancela alertas activas cuando el vehículo sale de la geocerca
   */
  clearAlert(deviceId, previousSeverity) {
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

    this._persistEvent(deviceId, null, 'exit', previousSeverity);
  }

  /**
   * Persiste el evento de entrada/salida para auditoría/historial,
   * sin bloquear el flujo en tiempo real (fire-and-forget) — un
   * fallo al guardar el evento no debe afectar la alerta ya emitida.
   */
  _persistEvent(deviceId, geofenceId, eventType, severity) {
    if (!this.geofenceEventRepo) return;
    this.geofenceEventRepo
      .record({ deviceId, geofenceId, eventType, severity })
      .catch(err => console.error('❌ GeofenceAlertService._persistEvent:', err.message));
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