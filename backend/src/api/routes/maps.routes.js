/**
 * maps.routes.js
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

const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

function buildMapsRouter({ mapsDir, mapRepo }) {
  const router = express.Router();
  const dbCache = new Map(); // mapId → Database (readonly)

  function getTilesDb(mapId) {
    if (dbCache.has(mapId)) return dbCache.get(mapId);
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
  router.invalidateCache = function invalidateCache(mapId) {
    const db = dbCache.get(mapId);
    if (db) {
      db.close();
      dbCache.delete(mapId);
    }
  };

  router.get('/maps/:mapId/:z/:x/:y.png', (req, res) => {
    const mapId = parseInt(req.params.mapId, 10);
    if (!Number.isInteger(mapId) || mapId <= 0) {
      return res.status(400).send('mapId inválido');
    }

    const zoom = parseInt(req.params.z, 10);
    const tileX = parseInt(req.params.x, 10);
    const tileY = (2 ** zoom - 1) - parseInt(req.params.y, 10);

    try {
      const db = getTilesDb(mapId);
      const row = db.prepare(
        'SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?'
      ).get(zoom, tileX, tileY);

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
      console.error(`❌ Error tile (mapa #${mapId}):`, err.message);
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
      console.error('❌ maps.routes GET /active-maps.json:', err.message);
      res.status(500).json({ error: 'Error obteniendo mapas activos' });
    }
  });

  return router;
}

/**
 * Normaliza una fila de `maps` a lo que necesita el frontend para
 * agregar la capa en MapLibre — usado tanto por /active-maps.json
 * como por el broadcast de socket `maps:active_update`.
 */
function toPublicShape(m) {
  return {
    id: m.id,
    name: m.name,
    tileUrlTemplate: `/tiles/maps/${m.id}/{z}/{x}/{y}.png`,
    bounds: m.bounds || null,
    minZoom: m.min_zoom,
    maxZoom: m.max_zoom
  };
}

module.exports = buildMapsRouter;
module.exports.toPublicShape = toPublicShape;
