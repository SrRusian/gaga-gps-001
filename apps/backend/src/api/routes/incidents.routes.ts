import type { RequestHandler } from 'express';
import express from 'express';
import type DeviceRepository from '../../repositories/DeviceRepository';
import type { IncidentCategory } from '../../repositories/IncidentReportRepository';
import type IncidentReportRepository from '../../repositories/IncidentReportRepository';
import type IncidentAlertService from '../../services/alerts/IncidentAlertService';
import type { UserRole } from '../../repositories/UserRepository';

const VALID_CATEGORIES: IncidentCategory[] = ['obstacle', 'accident', 'traffic', 'other'];

export interface IncidentsRouterDeps {
  incidentAlertService: IncidentAlertService;
  incidentRepo: IncidentReportRepository;
  deviceRepo: DeviceRepository;
  authMiddleware: RequestHandler;
  requireRole: (...roles: UserRole[]) => RequestHandler;
}

export function buildIncidentsRouter({
  incidentAlertService,
  incidentRepo,
  deviceRepo,
  authMiddleware,
  requireRole,
}: IncidentsRouterDeps) {
  const router = express.Router();

  router.get('/', authMiddleware, async (req, res) => {
    try {
      if (req.user!.projectId == null) {
        return res.status(400).json({ error: 'projectId es requerido (admin: use el panel del proyecto)' });
      }
      const incidents = await incidentRepo.findOpenByProject(req.user!.projectId);
      res.json(incidents);
    } catch (err) {
      console.error('incidents.routes GET /:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo incidentes' });
    }
  });

  router.post('/', authMiddleware, async (req, res) => {
    try {
      const { deviceId, category, message, latitude, longitude, radiusMeters } = req.body;

      if (!deviceId || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'deviceId, latitude y longitude son requeridos' });
      }
      if (category && !VALID_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: `category inválida - use: ${VALID_CATEGORIES.join(', ')}` });
      }

      const device = await deviceRepo.findByUniqueId(deviceId);
      if (!device || device.project_id === null) {
        return res.status(400).json({ error: 'El dispositivo no está registrado en ningún proyecto' });
      }

      const incident = await incidentAlertService.report({
        projectId: device.project_id,
        deviceId,
        reportedBy: req.user!.id,
        category: category || 'other',
        message,
        latitude,
        longitude,
        radiusMeters,
      });

      res.status(201).json(incident);
    } catch (err) {
      console.error('incidents.routes POST /:', (err as Error).message);
      res.status(500).json({ error: 'Error reportando incidente' });
    }
  });

  router.post(
    '/:id/resolve',
    authMiddleware,
    requireRole('admin', 'project_administrator', 'project_supervisor'),
    async (req, res) => {
      try {
        const incident = await incidentAlertService.resolve(Number(req.params.id), req.user!.id);
        if (!incident) return res.status(404).json({ error: 'Incidente no encontrado o ya resuelto' });
        res.json(incident);
      } catch (err) {
        console.error('incidents.routes POST /:id/resolve:', (err as Error).message);
        res.status(500).json({ error: 'Error resolviendo incidente' });
      }
    },
  );

  return router;
}

export default buildIncidentsRouter;
