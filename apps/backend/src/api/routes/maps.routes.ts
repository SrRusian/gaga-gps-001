import Database from 'better-sqlite3';
import express from 'express';
import path from 'path';
import { tryVerifyUser } from '../middleware/auth.middleware';
import type MapRepository from '../../repositories/MapRepository';
import type UserRepository from '../../repositories/UserRepository';
import { toPublicShape } from '../../services/maps/mapShape';

export { toPublicShape };

export interface MapsRouterDeps {
  mapsDir: string;
  mapRepo: MapRepository;
  userRepo: UserRepository;
}

export type MapsRouter = express.Router & { invalidateCache: (mapId: number) => void };

export function buildMapsRouter({ mapsDir, mapRepo, userRepo }: MapsRouterDeps): MapsRouter {
  const router = express.Router() as MapsRouter;
  const dbCache = new Map<number, InstanceType<typeof Database>>(); // mapId → Database (readonly)

  function getTilesDb(mapId: number) {
    if (dbCache.has(mapId)) return dbCache.get(mapId) as InstanceType<typeof Database>;
    const dbPath = path.join(mapsDir, `map_${mapId}.mbtiles`);
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    dbCache.set(mapId, db);
    return db;
  }

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
    const tileY = 2 ** zoom - 1 - parseInt(req.params.y, 10); // mbtiles usa esquema TMS (Y invertido)

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
      console.error(`Error tile (mapa #${mapId}):`, (err as Error).message);
      res.status(404).send('Mapa no disponible');
    }
  });

  router.get('/active-maps.json', async (req, res) => {
    try {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      const user = await tryVerifyUser(token, userRepo);
      const projectId = user ? (user.role === 'admin' ? null : user.projectId) : null;

      const maps = await mapRepo.findActiveReady(projectId);
      res.json(maps.map(toPublicShape));
    } catch (err) {
      console.error('maps.routes GET /active-maps.json:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo mapas activos' });
    }
  });

  return router;
}

export default buildMapsRouter;
