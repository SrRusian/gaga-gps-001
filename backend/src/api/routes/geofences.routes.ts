import type { RequestHandler } from 'express';
import express from 'express';
import type { LineString, Polygon } from 'geojson';
import GeofenceRepository from '../../repositories/GeofenceRepository';
import {
  geoJSONToGeofenceInputs,
  geofencesToGeoJSON,
  geofencesToKml,
  kmlToGeofenceInputs,
} from '../../utils/geoFormats';
import type GeofenceAlertService from '../../services/alerts/GeofenceAlertService';
import type { UserRole } from '../../repositories/UserRepository';

interface SocketServerLike {
  broadcastToProject(projectId: number | null, event: string, payload: unknown): void;
}

export interface GeofencesRouterDeps {
  geofenceRepo: GeofenceRepository;
  geofenceService: GeofenceAlertService;
  socketServer: SocketServerLike;
  authMiddleware: RequestHandler;
  downloadAuthMiddleware: RequestHandler;
  requireRole: (...roles: UserRole[]) => RequestHandler;
}

export function buildGeofencesRouter({
  geofenceRepo,
  geofenceService,
  socketServer,
  authMiddleware,
  downloadAuthMiddleware,
  requireRole,
}: GeofencesRouterDeps) {
  const router = express.Router();
  const canView = requireRole('admin', 'project_administrator', 'project_supervisor', 'project_manager');
  const canManage = requireRole('admin', 'project_administrator');

  router.get('/', authMiddleware, canView, async (req, res) => {
    try {
      const geofences = await geofenceRepo.findAllActive(req.user?.projectId);
      res.json(geofences);
    } catch (err) {
      console.error('geofences.routes GET /:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo geocercas' });
    }
  });

  router.post('/', authMiddleware, canManage, async (req, res) => {
    try {
      const {
        name,
        type,
        shapeType = 'circle',
        centerLat,
        centerLon,
        radiusMeters,
        geometry,
        corridorWidthMeters,
        corridorDangerMarginMeters,
        speedLimitKmh,
      } = req.body;

      if (!name || !type) {
        return res.status(400).json({ error: 'name y type son requeridos' });
      }

      const projectId = req.user!.projectId ?? req.body.projectId ?? null;
      if (projectId === null) {
        return res.status(400).json({ error: 'projectId es requerido' });
      }

      const validationError = validateShapeFields(shapeType, {
        centerLat,
        centerLon,
        radiusMeters,
        geometry,
        corridorWidthMeters,
      });
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }

      const geofence = await geofenceRepo.create({
        name,
        projectId,
        type,
        shapeType,
        centerLat,
        centerLon,
        radiusMeters,
        geometry,
        corridorWidthMeters,
        corridorDangerMarginMeters,
        speedLimitKmh,
      });

      geofenceService.addGeofence(GeofenceRepository.toMemoryFormat(geofence));

      socketServer.broadcastToProject(
        geofence.project_id,
        'geofences:update',
        geofenceService.activeGeofences,
      );
      res.status(201).json(geofence);
    } catch (err) {
      console.error('geofences.routes POST /:', (err as Error).message);
      res.status(500).json({ error: 'Error creando geocerca' });
    }
  });

  router.patch('/:id', authMiddleware, canManage, async (req, res) => {
    try {
      const existing = await geofenceRepo.findById(Number(req.params.id));
      if (!existing) return res.status(404).json({ error: 'Geocerca no encontrada' });
      if (req.user!.projectId != null && existing.project_id !== req.user!.projectId) {
        return res.status(404).json({ error: 'Geocerca no encontrada' });
      }

      const {
        name,
        type,
        active,
        centerLat,
        centerLon,
        radiusMeters,
        geometry,
        corridorWidthMeters,
        corridorDangerMarginMeters,
        speedLimitKmh,
      } = req.body;

      const geofence = await geofenceRepo.update(Number(req.params.id), {
        name,
        type,
        active,
        centerLat,
        centerLon,
        radiusMeters,
        geometry,
        corridorWidthMeters,
        corridorDangerMarginMeters,
        speedLimitKmh,
      });
      if (!geofence) return res.status(404).json({ error: 'Geocerca no encontrada' });

      if (geofence.active) {
        geofenceService.addGeofence(GeofenceRepository.toMemoryFormat(geofence));
      } else {
        geofenceService.removeGeofence(geofence.id);
      }
      socketServer.broadcastToProject(
        geofence.project_id,
        'geofences:update',
        geofenceService.activeGeofences,
      );

      res.json(geofence);
    } catch (err) {
      console.error('geofences.routes PATCH /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error actualizando geocerca' });
    }
  });

  router.delete('/:id', authMiddleware, canManage, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await geofenceRepo.findById(id);
      if (!existing) return res.status(404).json({ error: 'Geocerca no encontrada' });
      if (req.user!.projectId != null && existing.project_id !== req.user!.projectId) {
        return res.status(404).json({ error: 'Geocerca no encontrada' });
      }
      await geofenceRepo.delete(id);
      geofenceService.removeGeofence(id);
      socketServer.broadcastToProject(
        existing?.project_id ?? null,
        'geofences:update',
        geofenceService.activeGeofences,
      );
      res.json({ success: true });
    } catch (err) {
      console.error('geofences.routes DELETE /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error eliminando geocerca' });
    }
  });

  function resolveGeofences(req: express.Request) {
    const ids = String(req.query.ids || '')
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter(Number.isInteger);
    return ids.length > 0 ? geofenceRepo.findByIds(ids) : geofenceRepo.findAllActive();
  }

  router.get('/export.geojson', downloadAuthMiddleware, canView, async (req, res) => {
    try {
      const geofences = await resolveGeofences(req);
      res.setHeader('Content-Type', 'application/geo+json');
      res.setHeader('Content-Disposition', 'attachment; filename="geocercas.geojson"');
      res.json(geofencesToGeoJSON(geofences));
    } catch (err) {
      console.error('geofences.routes GET /export.geojson:', (err as Error).message);
      res.status(500).json({ error: 'Error exportando GeoJSON' });
    }
  });

  router.get('/export.kml', downloadAuthMiddleware, canView, async (req, res) => {
    try {
      const geofences = await resolveGeofences(req);
      res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
      res.setHeader('Content-Disposition', 'attachment; filename="geocercas.kml"');
      res.send(geofencesToKml(geofences));
    } catch (err) {
      console.error('geofences.routes GET /export.kml:', (err as Error).message);
      res.status(500).json({ error: 'Error exportando KML' });
    }
  });

  router.post('/import', authMiddleware, canManage, async (req, res) => {
    try {
      const { format, data } = req.body;

      const projectId = req.user!.projectId ?? req.body.projectId ?? null;
      if (projectId === null) {
        return res.status(400).json({ error: 'projectId es requerido' });
      }

      let inputs, errors;
      if (format === 'geojson') {
        ({ inputs, errors } = geoJSONToGeofenceInputs(data));
      } else if (format === 'kml') {
        ({ inputs, errors } = kmlToGeofenceInputs(data));
      } else {
        return res.status(400).json({ error: "format debe ser 'geojson' o 'kml'" });
      }

      const created = [];
      for (const input of inputs) {
        const geofence = await geofenceRepo.create({ ...input, projectId });
        geofenceService.addGeofence(GeofenceRepository.toMemoryFormat(geofence));
        created.push(geofence);
      }

      if (created.length > 0) {
        socketServer.broadcastToProject(
          projectId,
          'geofences:update',
          geofenceService.activeGeofences,
        );
      }

      res.status(created.length > 0 ? 201 : 400).json({
        imported: created.length,
        skipped: errors.length,
        errors,
        geofences: created,
      });
    } catch (err) {
      console.error('geofences.routes POST /import:', (err as Error).message);
      res
        .status(500)
        .json({ error: 'Error importando geocercas - verifique el formato del archivo' });
    }
  });

  return router;
}

interface ShapeFields {
  centerLat?: number;
  centerLon?: number;
  radiusMeters?: number;
  geometry?: Polygon | LineString;
  corridorWidthMeters?: number;
}

function validateShapeFields(
  shapeType: string,
  { centerLat, centerLon, radiusMeters, geometry, corridorWidthMeters }: ShapeFields,
): string | null {
  if (shapeType === 'circle') {
    if (centerLat === undefined || centerLon === undefined || !radiusMeters) {
      return 'Círculo requiere centerLat, centerLon y radiusMeters';
    }
    return null;
  }

  if (shapeType === 'polygon') {
    const poly = geometry as Polygon | undefined;
    if (
      !poly ||
      poly.type !== 'Polygon' ||
      !Array.isArray(poly.coordinates?.[0]) ||
      poly.coordinates[0].length < 3
    ) {
      return 'Polígono requiere geometry GeoJSON tipo Polygon con al menos 3 puntos';
    }
    return null;
  }

  if (shapeType === 'polyline') {
    const line = geometry as LineString | undefined;
    if (
      !line ||
      line.type !== 'LineString' ||
      !Array.isArray(line.coordinates) ||
      line.coordinates.length < 2
    ) {
      return 'Polilínea requiere geometry GeoJSON tipo LineString con al menos 2 puntos';
    }
    if (!corridorWidthMeters || corridorWidthMeters <= 0) {
      return 'Polilínea requiere corridorWidthMeters (ancho del corredor autorizado, en metros)';
    }
    return null;
  }

  return `shapeType inválido: ${shapeType}`;
}

export default buildGeofencesRouter;
