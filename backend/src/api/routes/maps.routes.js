/**
 * maps.routes.js
 *
 * Distribución de tiles MBTiles offline para las tabletas.
 * Extraído de app.js sin cambiar su comportamiento.
 *
 * RF asociados: RF-MAP-01, RF-MAP-02, RF-MAP-03
 */

const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

function buildMapsRouter({ mapsDir }) {
  const router = express.Router();
  let tilesDb = null;

  function getTilesDb() {
    if (tilesDb) return tilesDb;
    const dbPath = path.join(mapsDir, 'alcaraces.mbtiles');
    tilesDb = new Database(dbPath, { readonly: true });
    console.log('✅ MBTiles cargado');
    return tilesDb;
  }

  router.get('/alcaraces/:z/:x/:y.png', (req, res) => {
    const zoom = parseInt(req.params.z, 10);
    const tileX = parseInt(req.params.x, 10);
    const tileY = (2 ** zoom - 1) - parseInt(req.params.y, 10);

    try {
      const db = getTilesDb();
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
      console.error('❌ Error tile:', err.message);
      res.status(500).send('Error');
    }
  });

  return router;
}

module.exports = buildMapsRouter;
