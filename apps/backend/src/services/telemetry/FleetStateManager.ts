/**
 * FleetStateManager.ts
 *
 * Responsabilidad: Mantener el estado en tiempo real de la
 * flota (última posición conocida por dispositivo) en Redis,
 * para que cualquier instancia del backend pueda leerlo y para
 * reconstruir el estado cuando un cliente se conecta.
 *
 * RF asociados: RF-TEL-01, RF-TEL-02
 */
import type { FleetState, Position } from '@gaga-gps/shared-types';
import type Redis from 'ioredis';

const FLEET_KEY = 'gaga:fleet:state';

class FleetStateManager {
  redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Actualiza la posición de un dispositivo en el hash de Redis
   */
  async update(position: Position): Promise<void> {
    try {
      await this.redis.hset(FLEET_KEY, String(position.deviceId), JSON.stringify(position));
    } catch (err) {
      console.error('FleetStateManager.update:', (err as Error).message);
    }
  }

  /**
   * Retorna la última posición conocida de un dispositivo
   */
  async get(deviceId: string): Promise<Position | null> {
    try {
      const raw = await this.redis.hget(FLEET_KEY, String(deviceId));
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.error('FleetStateManager.get:', (err as Error).message);
      return null;
    }
  }

  /**
   * Retorna el estado completo de la flota como { deviceId: position }
   * Usado por CollisionRiskService.evaluate() y para hidratar
   * clientes que se conectan tarde.
   */
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

  /**
   * Elimina un dispositivo del estado de flota (p. ej. al darlo de baja)
   */
  async remove(deviceId: string): Promise<void> {
    try {
      await this.redis.hdel(FLEET_KEY, String(deviceId));
    } catch (err) {
      console.error('FleetStateManager.remove:', (err as Error).message);
    }
  }
}

export default FleetStateManager;
