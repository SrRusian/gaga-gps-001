/**
 * maps.routes.ts
 *
 * Distribución pública de tiles MBTiles offline (Operador/Supervisor,
 * sin autenticación individual — mismo criterio que /api/fleet/*) y
 * del estado actual de capas satelitales activas.
 *
 * Varios mapas pueden estar activos a la vez (ver
 * MapRepository.findActiveReady) — cada uno se sirve por su propio
 * id, no hay un único archivo fijo como antes.
 *
 * RF asociados: RF-MAP-01, RF-MAP-02, RF-MAP-03
 */
import Database from 'better-sqlite3';
import express from 'express';
import path from 'path';
import type MapRepository from '../../repositories/MapRepository';
import { toPublicShape } from '../../services/maps/mapShape';

export { toPublicShape };

export interface MapsRouterDeps {
  mapsDir: string;
  mapRepo: MapRepository;
}

export type MapsRouter = express.Router & { invalidateCache: (mapId: number) => void };

export function buildMapsRouter({ mapsDir, mapRepo }: MapsRouterDeps): MapsRouter {
  const router = express.Router() as MapsRouter;
  const dbCache = new Map<number, InstanceType<typeof Database>>(); // mapId → Database (readonly)

  function getTilesDb(mapId: number) {
    if (dbCache.has(mapId)) return dbCache.get(mapId) as InstanceType<typeof Database>;
    const dbPath = path.join(mapsDir, `map_${mapId}.mbtiles`);
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    dbCache.set(mapId, db);
    return db;
  }

  /**
   * Cierra y descarta el handle SQLite cacheado de un mapa — se
   * llama desde maps-admin.routes.js al eliminarlo, para no dejar un
   * handle abierto apuntando a un archivo ya borrado.
   */
  function invalidateCache(mapId: number): void {
    const db = dbCache.get(mapId);
    if (db) {
      db.close();
      dbCache.delete(mapId);
    }
  }
  router.invalidateCache = invalidateCache;

  router.get('/maps/:mapId/:z/:x/:y.png', (req, res) => {
    const mapId = parseInt(req.params.mapId, 10);
    if (!Number.isInteger(mapId) || mapId <= 0) {
      return res.status(400).send('mapId inválido');
    }

    const zoom = parseInt(req.params.z, 10);
    const tileX = parseInt(req.params.x, 10);
    const tileY = 2 ** zoom - 1 - parseInt(req.params.y, 10);

    try {
      const db = getTilesDb(mapId);
      const row = db
        .prepare('SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?')
        .get(zoom, tileX, tileY) as { tile_data: Buffer } | undefined;

      if (row) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(Buffer.from(row.tile_data));
      } else {
        res.status(204).send();
      }
    } catch (err) {
      // Archivo inexistente (mapa borrado/no listo) u otro error de
      // lectura — no debe tumbar el request, solo faltar ese tile.
      console.error(`❌ Error tile (mapa #${mapId}):`, (err as Error).message);
      res.status(404).send('Mapa no disponible');
    }
  });

  /**
   * Estado actual de capas satelitales activas — lo consumen
   * Operador/Supervisor al cargar (antes de que llegue cualquier
   * evento de socket) y el panel Admin. Mismo shape que el evento
   * de socket `maps:active_update` (ver maps-admin.routes.js).
   */
  router.get('/active-maps.json', async (req, res) => {
    try {
      const maps = await mapRepo.findActiveReady();
      res.json(maps.map(toPublicShape));
    } catch (err) {
      console.error('❌ maps.routes GET /active-maps.json:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo mapas activos' });
    }
  });

  return router;
}

export default buildMapsRouter;
