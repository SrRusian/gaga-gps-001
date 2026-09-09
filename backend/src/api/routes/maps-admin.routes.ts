import type { Request, RequestHandler } from 'express';
import express from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import multer from 'multer';
import path from 'path';
import { env } from '../../config';
import type MapRepository from '../../repositories/MapRepository';
import type { UserRole } from '../../repositories/UserRepository';
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
  requireRole: (...roles: UserRole[]) => RequestHandler;
}

export function buildMapsAdminRouter({
  mapRepo,
  mapPipelineService,
  mapsDir,
  invalidateTilesCache,
  socketServer,
  requireRole,
}: MapsAdminRouterDeps) {
  const router = express.Router();
  const sourcesDir = path.join(mapsDir, 'sources');
  const uploadTmpDir = path.join(mapsDir, 'tmp-uploads');
  const canView = requireRole('admin', 'project_administrator', 'project_supervisor', 'project_manager');
  const canManage = requireRole('admin', 'project_administrator');

  function hasProjectAccess(req: Request, mapProjectId: number | null): boolean {
    return req.user!.projectId == null || req.user!.projectId === mapProjectId;
  }

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

  router.get('/', canView, async (req, res) => {
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
    canManage,
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

        mapPipelineService.process(mapRow.id, finalImagePath, finalWorldPath, sourceCrs || null);
      } catch (err) {
        await fs.rm(imageFile?.path || '', { force: true }).catch(() => {});
        await fs.rm(worldFile?.path || '', { force: true }).catch(() => {});
        console.error('maps-admin.routes POST /:', (err as Error).message);
        if (!res.headersSent)
          res.status(500).json({ error: 'Error iniciando la importación del mapa' });
      }
    },
  );

  router.patch('/:id', canManage, async (req, res) => {
    try {
      const { name, projectId } = req.body;
      if (!name) return res.status(400).json({ error: 'name es requerido' });
      const existing = await mapRepo.findById(Number(req.params.id));
      if (!existing) return res.status(404).json({ error: 'Mapa no encontrado' });
      if (!hasProjectAccess(req, existing.project_id)) {
        return res.status(403).json({ error: 'El mapa no pertenece a su proyecto' });
      }

      // reasignar de proyecto es exclusivo del admin global - un project_administrator solo
      // administra el suyo, no hay "otro proyecto" al que mandarlo. Se rechaza aqui tambien (no
      // solo ocultando el selector en el frontend) para que no se pueda forzar via API directa.
      let targetProjectId: number | undefined;
      if (projectId !== undefined) {
        if (req.user!.role !== 'admin') {
          return res
            .status(403)
            .json({ error: 'Solo el administrador global puede cambiar el proyecto de un mapa' });
        }
        targetProjectId = Number(projectId);
        if (!Number.isInteger(targetProjectId)) {
          return res.status(400).json({ error: 'projectId inválido' });
        }
      }

      const map = await mapRepo.update(Number(req.params.id), { name, projectId: targetProjectId });
      if (!map) return res.status(404).json({ error: 'Mapa no encontrado' });

      // si el mapa activo cambio de proyecto, el viejo proyecto debe dejar de verlo en vivo y el
      // nuevo debe empezar a verlo - re-emitir la lista de activos a ambos
      if (map.active && targetProjectId !== undefined && targetProjectId !== existing.project_id) {
        await broadcastActiveMaps(existing.project_id);
        await broadcastActiveMaps(map.project_id);
      }

      res.json(map);
    } catch (err) {
      console.error('maps-admin.routes PATCH /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error actualizando el mapa' });
    }
  });

  router.post('/:id/activate', canManage, async (req, res) => {
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

  router.post('/:id/deactivate', canManage, async (req, res) => {
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

  router.delete('/:id', canManage, async (req, res) => {
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
