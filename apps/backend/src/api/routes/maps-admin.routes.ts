/**
 * maps-admin.routes.ts
 *
 * Responsabilidad: Importar, listar, activar, renombrar y eliminar
 * mapas satelitales/drone (TIF+TFW o JPG+JPW → MBTiles) desde el
 * panel Admin. Protegida con JWT + rol admin/project_manager
 * (aplicado al montar en app.ts, mismo patrón que /api/users) - un
 * Encargado de Proyecto tiene acceso completo, pero acotado a los
 * mapas de su propio proyecto (ver `assertProjectAccess` abajo,
 * `GET /` ya filtra por `req.user.projectId` vía `mapRepo.findAll`).
 *
 * El procesamiento GDAL corre en segundo plano (no se espera en la
 * request) - MapPipelineService.process() nunca lanza, cualquier
 * fallo deja la fila en status='failed' con error_message.
 *
 * RF asociados: RF-MAP-01, RF-MAP-02, RF-MAP-03
 */
import type { Request } from 'express';
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
  broadcastToProject(projectId: number | null, event: string, payload: unknown): void;
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
   * Admin (req.user.projectId == null) siempre tiene acceso - un
   * Encargado de Proyecto solo al mapa cuyo project_id coincida con
   * el suyo. A diferencia de `GET /` (que filtra la lista completa
   * desde el repositorio), rename/activate/deactivate/delete operan
   * por id directo - sin este chequeo, un Encargado podría adivinar
   * el id de un mapa de OTRO proyecto y modificarlo/eliminarlo
   * saltándose por completo el aislamiento por proyecto.
   */
  function hasProjectAccess(req: Request, mapProjectId: number | null): boolean {
    return req.user!.projectId == null || req.user!.projectId === mapProjectId;
  }

  /**
   * Difunde el conjunto actual de capas activas a Operador/Supervisor
   * en tiempo real - se llama tras activar/desactivar un mapa.
   * Mismo shape que GET /tiles/active-maps.json. Acotado al proyecto
   * del mapa (`broadcastToProject` - solo esa sala + admins, que
   * reciben todo) - antes usaba `broadcast()` sin filtrar, mandando
   * TODOS los mapas activos de TODOS los proyectos a cualquier
   * socket conectado (Operador/Supervisor de un proyecto ajeno
   * habría recibido y renderizado capas satelitales que no son
   * suyas). Encontrado al agregar el mismo socket a Admin/Encargado
   * en esta ronda - Admin/Encargado ya filtran del lado del cliente
   * (`scopedActiveMaps`) así que el payload sin filtrar no les
   * afectaba, pero Operador/Supervisor sí consumen el payload
   * directo sin volver a filtrar.
   */
  async function broadcastActiveMaps(projectId: number | null) {
    const maps = await mapRepo.findActiveReady(projectId);
    socketServer.broadcastToProject(projectId, 'maps:active_update', { maps: maps.map(toPublicShape) });
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
      const maps = await mapRepo.findAll(req.user?.projectId);
      res.json(maps);
    } catch (err) {
      console.error('maps-admin.routes GET /:', (err as Error).message);
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
          return res.status(400).json({ error: 'sourceCrs inválido - formato esperado EPSG:XXXX' });
        }

        // Mismo patrón que geocercas/equipo: Encargado/Supervisor de
        // Proyecto no elige, siempre es el suyo; Admin debe indicarlo.
        // req.body.projectId llega como string (multipart/form-data
        // vía multer nunca tipa los campos de texto) - se normaliza
        // explícitamente, la columna es INTEGER.
        const projectId = req.user!.projectId ?? (req.body.projectId ? Number(req.body.projectId) : null);
        if (projectId === null) {
          return res.status(400).json({ error: 'projectId es requerido' });
        }

        const mapRow = await mapRepo.create({ name, projectId, uploadedBy: req.user?.id });

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

        // Procesamiento GDAL en segundo plano - puede tardar varios
        // minutos en ortofotos grandes; nunca bloquea esta request ni
        // el event loop (ver MapPipelineService, usa execFile async).
        mapPipelineService.process(mapRow.id, finalImagePath, finalWorldPath, sourceCrs || null);
      } catch (err) {
        // Limpieza best-effort de los temporales de multer si algo
        // falló antes de moverlos a su destino final.
        await fs.rm(imageFile?.path || '', { force: true }).catch(() => {});
        await fs.rm(worldFile?.path || '', { force: true }).catch(() => {});
        console.error('maps-admin.routes POST /:', (err as Error).message);
        if (!res.headersSent)
          res.status(500).json({ error: 'Error iniciando la importación del mapa' });
      }
    },
  );

  router.patch('/:id', async (req, res) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'name es requerido' });
      const existing = await mapRepo.findById(Number(req.params.id));
      if (!existing) return res.status(404).json({ error: 'Mapa no encontrado' });
      if (!hasProjectAccess(req, existing.project_id)) {
        return res.status(403).json({ error: 'El mapa no pertenece a su proyecto' });
      }
      const map = await mapRepo.rename(Number(req.params.id), name);
      res.json(map);
    } catch (err) {
      console.error('maps-admin.routes PATCH /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error renombrando el mapa' });
    }
  });

  router.post('/:id/activate', async (req, res) => {
    try {
      const map = await mapRepo.findById(Number(req.params.id));
      if (!map) return res.status(404).json({ error: 'Mapa no encontrado' });
      if (!hasProjectAccess(req, map.project_id)) {
        return res.status(403).json({ error: 'El mapa no pertenece a su proyecto' });
      }
      if (map.status !== 'ready') {
        return res.status(409).json({ error: 'Solo se puede activar un mapa con status=ready' });
      }

      const updated = await mapRepo.setActive(map.id, true);
      await broadcastActiveMaps(map.project_id);

      res.json(updated);
    } catch (err) {
      console.error('maps-admin.routes POST /:id/activate:', (err as Error).message);
      res.status(500).json({ error: 'Error activando el mapa' });
    }
  });

  router.post('/:id/deactivate', async (req, res) => {
    try {
      const map = await mapRepo.findById(Number(req.params.id));
      if (!map) return res.status(404).json({ error: 'Mapa no encontrado' });
      if (!hasProjectAccess(req, map.project_id)) {
        return res.status(403).json({ error: 'El mapa no pertenece a su proyecto' });
      }

      const updated = await mapRepo.setActive(map.id, false);
      await broadcastActiveMaps(map.project_id);

      res.json(updated);
    } catch (err) {
      console.error('maps-admin.routes POST /:id/deactivate:', (err as Error).message);
      res.status(500).json({ error: 'Error desactivando el mapa' });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const map = await mapRepo.findById(Number(req.params.id));
      if (!map) return res.status(404).json({ error: 'Mapa no encontrado' });
      if (!hasProjectAccess(req, map.project_id)) {
        return res.status(403).json({ error: 'El mapa no pertenece a su proyecto' });
      }
      if (map.active) {
        return res
          .status(409)
          .json({ error: 'No se puede eliminar el mapa activo - desactívelo primero' });
      }

      await mapPipelineService.deleteFile(map.mbtiles_filename);
      invalidateTilesCache(map.id);
      await fs
        .rm(path.join(sourcesDir, String(map.id)), { recursive: true, force: true })
        .catch(() => {});
      await mapRepo.delete(map.id);

      res.json({ success: true });
    } catch (err) {
      console.error('maps-admin.routes DELETE /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error eliminando el mapa' });
    }
  });

  return router;
}

export default buildMapsAdminRouter;
