import type { FleetState, Position } from '@gaga-gps/shared-types';
import type Redis from 'ioredis';

const FLEET_KEY = 'gaga:fleet:state';

class FleetStateManager {
  redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async update(position: Position): Promise<void> {
    try {
      await this.redis.hset(FLEET_KEY, String(position.deviceId), JSON.stringify(position));
    } catch (err) {
      console.error('FleetStateManager.update:', (err as Error).message);
    }
  }

  async get(deviceId: string): Promise<Position | null> {
    try {
      const raw = await this.redis.hget(FLEET_KEY, String(deviceId));
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.error('FleetStateManager.get:', (err as Error).message);
      return null;
    }
  }

  async getAll(): Promise<FleetState> {
    try {
      const raw = await this.redis.hgetall(FLEET_KEY);
      const fleet: FleetState = {};
      for (const [deviceId, json] of Object.entries(raw)) {
        try {
          fleet[deviceId] = JSON.parse(json);
        } catch {
          // Ignorar entradas corruptas
        }
      }
      return fleet;
    } catch (err) {
      console.error('FleetStateManager.getAll:', (err as Error).message);
      return {};
    }
  }

  async remove(deviceId: string): Promise<void> {
    try {
      await this.redis.hdel(FLEET_KEY, String(deviceId));
    } catch (err) {
      console.error('FleetStateManager.remove:', (err as Error).message);
    }
  }
}

export default FleetStateManager;
