/**
 * DeviceManager.ts
 *
 * Responsabilidad: Auto-registrar dispositivos nuevos que
 * envían telemetría por primera vez y mantener su estado
 * (online/offline) actualizado en PostgreSQL.
 */
import type DeviceRepository from '../../repositories/DeviceRepository';
import type { DeviceRow } from '../../repositories/DeviceRepository';

class DeviceManager {
  deviceRepo: DeviceRepository;

  constructor({ deviceRepo }: { deviceRepo: DeviceRepository }) {
    this.deviceRepo = deviceRepo;
  }

  /**
   * Garantiza que el dispositivo exista en PostgreSQL.
   * Si es la primera vez que se ve ese unique_id, lo crea
   * automáticamente — no requiere alta manual previa.
   */
  async ensureRegistered(uniqueId: string): Promise<DeviceRow> {
    return this.deviceRepo.findOrCreate(uniqueId);
  }

  /**
   * Marca el dispositivo como online y actualiza last_update
   */
  async markOnline(uniqueId: string, timestamp: Date = new Date()): Promise<void> {
    return this.deviceRepo.updateStatus(uniqueId, 'online', timestamp);
  }

  async markOffline(uniqueId: string): Promise<void> {
    return this.deviceRepo.updateStatus(uniqueId, 'offline');
  }
}

export default DeviceManager;
