/**
 * DeviceManager.js
 *
 * Responsabilidad: Auto-registrar dispositivos nuevos que
 * envían telemetría por primera vez y mantener su estado
 * (online/offline) actualizado en PostgreSQL.
 */

class DeviceManager {

  constructor({ deviceRepo }) {
    this.deviceRepo = deviceRepo;
  }

  /**
   * Garantiza que el dispositivo exista en PostgreSQL.
   * Si es la primera vez que se ve ese unique_id, lo crea
   * automáticamente — no requiere alta manual previa.
   */
  async ensureRegistered(uniqueId) {
    return this.deviceRepo.findOrCreate(uniqueId);
  }

  /**
   * Marca el dispositivo como online y actualiza last_update
   */
  async markOnline(uniqueId, timestamp = new Date()) {
    return this.deviceRepo.updateStatus(uniqueId, 'online', timestamp);
  }

  async markOffline(uniqueId) {
    return this.deviceRepo.updateStatus(uniqueId, 'offline');
  }
}

module.exports = DeviceManager;
