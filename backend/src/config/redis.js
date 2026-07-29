/**
 * redis.js
 *
 * Responsabilidad: Exponer un cliente Redis (ioredis) para
 * almacenar el estado en memoria de la flota (FleetStateManager)
 * y otros datos efímeros.
 */

const Redis = require('ioredis');

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  retryStrategy(times) {
    const delay = Math.min(times * 500, 5000);
    return delay;
  },
  maxRetriesPerRequest: 3
});

redis.on('connect', () => {
  console.log('✅ Redis — conectado');
});

redis.on('error', (err) => {
  console.error('❌ Redis — error:', err.message);
});

async function checkConnection() {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch (err) {
    console.error('❌ Redis no disponible:', err.message);
    return false;
  }
}

module.exports = { redis, checkConnection };
