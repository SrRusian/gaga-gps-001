import type { RequestHandler } from 'express';
import express from 'express';
import type DeviceGroupRepository from '../../repositories/DeviceGroupRepository';

export interface DeviceGroupsRouterDeps {
  deviceGroupRepo: DeviceGroupRepository;
  requireRole: (...roles: string[]) => RequestHandler;
}

export function buildDeviceGroupsRouter({ deviceGroupRepo, requireRole }: DeviceGroupsRouterDeps) {
  const router = express.Router();
  const canView = requireRole('admin', 'project_administrator', 'project_supervisor', 'project_manager');
  const canManage = requireRole('admin', 'project_administrator');

  router.get('/', canView, async (req, res) => {
    try {
      const groups = await deviceGroupRepo.findByProject(req.user!.projectId);
      res.json(groups);
    } catch (err) {
      console.error('device-groups.routes GET /:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo grupos' });
    }
  });

  router.post('/', canManage, async (req, res) => {
    try {
      const { name, speedLimitKmh } = req.body;
      if (!name) return res.status(400).json({ error: 'name es requerido' });
      const projectId = req.user!.role === 'admin' ? (req.body.projectId ?? null) : req.user!.projectId;
      const group = await deviceGroupRepo.create({ projectId, name, speedLimitKmh });
      res.status(201).json(group);
    } catch (err) {
      console.error('device-groups.routes POST /:', (err as Error).message);
      res.status(500).json({ error: 'Error creando grupo' });
    }
  });

  router.patch('/:id', canManage, async (req, res) => {
    try {
      const { name, speedLimitKmh } = req.body;
      const group = await deviceGroupRepo.update(Number(req.params.id), { name, speedLimitKmh });
      if (!group) return res.status(404).json({ error: 'Grupo no encontrado' });
      res.json(group);
    } catch (err) {
      console.error('device-groups.routes PATCH /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error actualizando grupo' });
    }
  });

  router.delete('/:id', canManage, async (req, res) => {
    try {
      await deviceGroupRepo.delete(Number(req.params.id));
      res.json({ success: true });
    } catch (err) {
      console.error('device-groups.routes DELETE /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error eliminando grupo' });
    }
  });

  return router;
}

export default buildDeviceGroupsRouter;
