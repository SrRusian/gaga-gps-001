import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import type MapPipelineService from '../../services/maps/MapPipelineService';
import { ProjectHasDependentsError } from '../../repositories/ProjectRepository';
import type MapRepository from '../../repositories/MapRepository';
import type ProjectRepository from '../../repositories/ProjectRepository';
import type { UserRole } from '../../repositories/UserRepository';

interface SocketServerLike {
  broadcast(event: string, payload: unknown): void;
  broadcastToProject(projectId: number | null, event: string, payload: unknown): void;
}

export interface ProjectsRouterDeps {
  projectRepo: ProjectRepository;
  mapRepo: MapRepository;
  mapPipelineService: MapPipelineService;
  mapsDir: string;
  invalidateTilesCache: (mapId: number) => void;
  socketServer: SocketServerLike;
  requireRole: (...roles: UserRole[]) => import('express').RequestHandler;
}

export function buildProjectsRouter({
  projectRepo,
  mapRepo,
  mapPipelineService,
  mapsDir,
  invalidateTilesCache,
  socketServer,
  requireRole,
}: ProjectsRouterDeps) {
  const router = express.Router();
  const sourcesDir = path.join(mapsDir, 'sources');

  router.get('/', async (req, res) => {
    try {
      const projects =
        req.user!.projectId != null
          ? await projectRepo.findById(req.user!.projectId).then((p) => (p ? [p] : []))
          : await projectRepo.findAll();
      res.json(projects);
    } catch (err) {
      console.error('projects.routes GET /:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo proyectos' });
    }
  });

  router.post('/', requireRole('admin'), async (req, res) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'name es requerido' });
      const project = await projectRepo.create({ name });
      res.status(201).json(project);
    } catch (err) {
      console.error('projects.routes POST /:', (err as Error).message);
      res.status(500).json({ error: 'Error creando proyecto' });
    }
  });

  router.patch('/:id', requireRole('admin'), async (req, res) => {
    try {
      const { name, active } = req.body;
      const project = await projectRepo.update(Number(req.params.id), { name, active });
      if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' });
      res.json(project);
    } catch (err) {
      console.error('projects.routes PATCH /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error actualizando proyecto' });
    }
  });

  router.delete('/:id', requireRole('admin'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await projectRepo.findById(id);
      if (!existing) return res.status(404).json({ error: 'Proyecto no encontrado' });

      const projectMaps = await mapRepo.findAll(id);
      for (const m of projectMaps) {
        await mapPipelineService.deleteFile(m.mbtiles_filename);
        invalidateTilesCache(m.id);
        await fs.rm(path.join(sourcesDir, String(m.id)), { recursive: true, force: true }).catch(() => {});
      }

      await projectRepo.delete(id);

      if (projectMaps.some((m) => m.active)) {
        socketServer.broadcastToProject(id, 'maps:active_update', { maps: [] });
      }

      res.json({ success: true });
    } catch (err) {
      if (err instanceof ProjectHasDependentsError) {
        return res.status(409).json({ error: err.message, code: err.code });
      }
      console.error('projects.routes DELETE /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error eliminando proyecto' });
    }
  });

  return router;
}

export default buildProjectsRouter;
