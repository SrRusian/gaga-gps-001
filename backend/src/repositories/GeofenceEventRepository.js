/**
 * GeofenceEventRepository.js
 *
 * Responsabilidad: Persistir eventos de entrada/salida de
 * geocercas para auditoría e historial — GeofenceAlertService ya
 * emite estas alertas en tiempo real vía Socket.io; este repositorio
 * las guarda además en PostgreSQL para poder consultarlas después
 * (reportes, cruce con el recorrido histórico de un vehículo).
 */

const { query } = require('../config/database');

class GeofenceEventRepository {

  async record({ deviceId, geofenceId, eventType, severity }) {
    try {
      const { rows } = await query(
        `INSERT INTO geofence_events (device_id, geofence_id, event_type, severity)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [deviceId, geofenceId, eventType, severity || null]
      );
      return rows[0];
    } catch (err) {
      console.error('❌ GeofenceEventRepository.record:', err.message);
      throw err;
    }
  }

  /**
   * Historial de eventos de un dispositivo en un rango de fechas —
   * usado para cruzar contra el recorrido (route-zone-crossref) y
   * para reportes de auditoría.
   */
  async findByDeviceAndRange({ deviceId, from, to }) {
    try {
      const { rows } = await query(
        `SELECT * FROM geofence_events
         WHERE device_id = $1 AND occurred_at BETWEEN $2 AND $3
         ORDER BY occurred_at ASC`,
        [deviceId, from, to]
      );
      return rows;
    } catch (err) {
      console.error('❌ GeofenceEventRepository.findByDeviceAndRange:', err.message);
      throw err;
    }
  }
}

module.exports = GeofenceEventRepository;
