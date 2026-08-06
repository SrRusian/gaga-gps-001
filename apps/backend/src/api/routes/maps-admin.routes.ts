/**
 * maps-admin.routes.ts
 *
 * Responsabilidad: Importar, listar, activar, renombrar y eliminar
 * mapas satelitales/drone (TIF+TFW o JPG+JPW → MBTiles) desde el
 * panel Admin. Protegida con JWT + rol admin (aplicado al montar
 * en app.js, mismo patrón que /api/users).
 *
 * El procesamiento GDAL corre en segundo plano (no se espera en la
 * request) — MapPipelineService.process() nunca lanza, cualquier
 * fallo deja la fila en status='failed' con error_message.
 *
 * RF asociados: RF-MAP-01, RF-MAP-02, RF-MAP-03
 */
import express from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import multer from 'multer';
import path from 'path';
import { env } from '../../config';
import type MapRepository from '../../repositories/MapRepository';
import type MapPipelineService from '../../services/maps/MapPipelineService';
import { toPublicShape } from '../../services/maps/mapShape';

const ALLOWED_IMAGE_EXT = ['.tif', '.tiff', '.jpg', '.jpeg'];
const ALLOWED_WORLD_EXT = ['.tfw', '.jpw', '.wld'];
const CRS_PATTERN = /^EPSG:\d+$/;

interface SocketServerLike {
  broadcast(event: string, payload: unknown): void;
}

export interface MapsAdminRouterDeps {
  mapRepo: MapRepository;
  mapPipelineService: MapPipelineService;
  mapsDir: string;
  invalidateTilesCache: (mapId: number) => void;
  socketServer: SocketServerLike;
}

export function buildMapsAdminRouter({
  mapRepo,
  mapPipelineService,
  mapsDir,
  invalidateTilesCache,
  socketServer,
}: MapsAdminRouterDeps) {
  const router = express.Router();
  const sourcesDir = path.join(mapsDir, 'sources');
  const uploadTmpDir = path.join(mapsDir, 'tmp-uploads');

  /**
   * Difunde el conjunto actual de capas activas a Operador/Supervisor
   * en tiempo real — se llama tras activar/desactivar/eliminar un
   * mapa activo. Mismo shape que GET /tiles/active-maps.json.
   */
  async function broadcastActiveMaps() {
    const maps = await mapRepo.findActiveReady();
    socketServer.broadcast('maps:active_update', { maps: maps.map(toPublicShape) });
  }

  fsSync.mkdirSync(uploadTmpDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadTmpDir),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
      },
    }),
    limits: { fileSize: env.maxMapUploadMb * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const okImage = file.fieldname === 'image' && ALLOWED_IMAGE_EXT.includes(ext);
      const okWorld = file.fieldname === 'worldFile' && ALLOWED_WORLD_EXT.includes(ext);
      if (okImage || okWorld) {
        cb(null, true);
      } else {
        cb(new Error(`Extensión no permitida para ${file.fieldname}: ${ext}`));
      }
    },
  });

  router.get('/', async (req, res) => {
    try {
      const maps = await mapRepo.findAll();
      res.json(maps);
    } catch (err) {
      console.error('❌ maps-admin.routes GET /:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo mapas' });
    }
  });

  router.post(
    '/',
    upload.fields([
      { name: 'image', maxCount: 1 },
      { name: 'worldFile', maxCount: 1 },
    ]),
    async (req, res) => {
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const imageFile = files?.image?.[0];
      const worldFile = files?.worldFile?.[0];

      try {
        const { name, sourceCrs } = req.body;

        if (!name || !imageFile || !worldFile) {
          return res.status(400).json({ error: 'name, image y worldFile son requeridos' });
        }
        if (sourceCrs && !CRS_PATTERN.test(sourceCrs)) {
          return res.status(400).json({ error: 'sourceCrs inválido — formato esperado EPSG:XXXX' });
        }

        const mapRow = await mapRepo.create({ name, uploadedBy: req.user?.id });

        const destDir = path.join(sourcesDir, String(mapRow.id));
        await fs.mkdir(destDir, { recursive: true });

        const finalImageName = `image${path.extname(imageFile.originalname).toLowerCase()}`;
        const finalWorldName = `world${path.extname(worldFile.originalname).toLowerCase()}`;
        const finalImagePath = path.join(destDir, finalImageName);
        const finalWorldPath = path.join(destDir, finalWorldName);

        await fs.rename(imageFile.path, finalImagePath);
        await fs.rename(worldFile.path, finalWorldPath);
        await mapRepo.setSourceFiles(mapRow.id, {
          sourceImageFilename: finalImageName,
          sourceWorldFilename: finalWorldName,
        });

        res.status(202).json(mapRow);

        // Procesamiento GDAL en segundo plano — puede tardar varios
        // minutos en ortofotos grandes; nunca bloquea esta request ni
        // el event loop (ver MapPipelineService, usa execFile async).
        mapPipelineService.process(mapRow.id, finalImagePath, finalWorldPath, sourceCrs || null);
      } catch (err) {
        // Limpieza best-effort de los temporales de multer si algo
        // falló antes de moverlos a su destino final.
        await fs.rm(imageFile?.path || '', { force: true }).catch(() => {});
        await fs.rm(worldFile?.path || '', { force: true }).catch(() => {});
        console.error('❌ maps-admin.routes POST /:', (err as Error).message);
        if (!res.headersSent)
          res.status(500).json({ error: 'Error iniciando la importación del mapa' });
      }
    },
  );

  router.patch('/:id', async (req, res) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'name es requerido' });
      const map = await mapRepo.rename(Number(req.params.id), name);
      if (!map) return res.status(404).json({ error: 'Mapa no encontrado' });
      res.json(map);
    } catch (err) {
      console.error('❌ maps-admin.routes PATCH /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error renombrando el mapa' });
    }
  });

  router.post('/:id/activate', async (req, res) => {
    try {
      const map = await mapRepo.findById(Number(req.params.id));
      if (!map) return res.status(404).json({ error: 'Mapa no encontrado' });
      if (map.status !== 'ready') {
        return res.status(409).json({ error: 'Solo se puede activar un mapa con status=ready' });
      }

      const updated = await mapRepo.setActive(map.id, true);
      await broadcastActiveMaps();

      res.json(updated);
    } catch (err) {
      console.error('❌ maps-admin.routes POST /:id/activate:', (err as Error).message);
      res.status(500).json({ error: 'Error activando el mapa' });
    }
  });

  router.post('/:id/deactivate', async (req, res) => {
    try {
      const map = await mapRepo.findById(Number(req.params.id));
      if (!map) return res.status(404).json({ error: 'Mapa no encontrado' });

      const updated = await mapRepo.setActive(map.id, false);
      await broadcastActiveMaps();

      res.json(updated);
    } catch (err) {
      console.error('❌ maps-admin.routes POST /:id/deactivate:', (err as Error).message);
      res.status(500).json({ error: 'Error desactivando el mapa' });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const map = await mapRepo.findById(Number(req.params.id));
      if (!map) return res.status(404).json({ error: 'Mapa no encontrado' });
      if (map.active) {
        return res
          .status(409)
          .json({ error: 'No se puede eliminar el mapa activo — desactívelo primero' });
      }

      await mapPipelineService.deleteFile(map.mbtiles_filename);
      invalidateTilesCache(map.id);
      await fs
        .rm(path.join(sourcesDir, String(map.id)), { recursive: true, force: true })
        .catch(() => {});
      await mapRepo.delete(map.id);

      res.json({ success: true });
    } catch (err) {
      console.error('❌ maps-admin.routes DELETE /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error eliminando el mapa' });
    }
  });

  return router;
}

export default buildMapsAdminRouter;
