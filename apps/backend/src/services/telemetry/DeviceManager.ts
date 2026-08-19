import type DeviceRepository from '../../repositories/DeviceRepository';
import type { DeviceRow } from '../../repositories/DeviceRepository';

class DeviceManager {
  deviceRepo: DeviceRepository;

  constructor({ deviceRepo }: { deviceRepo: DeviceRepository }) {
    this.deviceRepo = deviceRepo;
  }

  async ensureRegistered(uniqueId: string): Promise<DeviceRow> {
    return this.deviceRepo.findOrCreate(uniqueId);
  }

  async markOnline(uniqueId: string, timestamp: Date = new Date()): Promise<void> {
    return this.deviceRepo.updateStatus(uniqueId, 'online', timestamp);
  }

  async markOffline(uniqueId: string): Promise<void> {
    return this.deviceRepo.updateStatus(uniqueId, 'offline');
  }
}

export default DeviceManager;
