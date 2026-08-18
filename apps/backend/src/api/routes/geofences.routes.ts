/**
 * geofences.routes.ts
 *
 * CRUD de geocercas persistidas en PostgreSQL. Cada cambio se
 * refleja de inmediato en GeofenceAlertService (memoria) y se
 * notifica a todos los clientes conectados vía Socket.io.
 *
 * Soporta 3 formas: círculo (centerLat/centerLon/radiusMeters),
 * polígono (geometry GeoJSON Polygon) y polilínea/corredor
 * (geometry GeoJSON LineString + corridorWidthMeters).
 *
 * RF asociados: RF-ALR-02, RF-ALR-03
 */
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

  // Antes solo exigía sesión válida (cualquier rol autenticado,
  // incluido operador), sin restricción real - Admin/Encargado/
  // Supervisor de Proyecto tienen acceso completo (crear/editar/
  // eliminar/importar/exportar) dentro de su propio proyecto; el
  // resto de roles queda fuera.
  const canManage = requireRole('admin', 'project_manager', 'project_supervisor');

  router.get('/', authMiddleware, canManage, async (req, res) => {
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
      } = req.body;

      if (!name || !type) {
        return res.status(400).json({ error: 'name y type son requeridos' });
      }

      // Admin (projectId null) debe indicar a qué proyecto pertenece;
      // un Encargado/Supervisor de proyecto no elige, siempre es el suyo.
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
      });

      // Reflejar en memoria para evaluación en tiempo real (GeofenceAlertService)
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
      });
      if (!geofence) return res.status(404).json({ error: 'Geocerca no encontrada' });

      // Reflejar el cambio en memoria y notificar en vivo a
      // Operador/Supervisor (misma mecánica que crear/eliminar)
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
      // Se busca ANTES de borrar - una vez eliminada la fila ya no
      // hay forma de saber a qué proyecto avisar (mismo motivo por
      // el que IncidentAlertService.resolveDeviceIncidents se llama
      // antes de purgar, ver CLAUDE.md).
      const existing = await geofenceRepo.findById(id);
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

  // ── Exportación en formatos estándar ────────────────────────────
  // Ambas rutas aceptan ?ids=1,2,3 opcional para exportar solo un
  // subconjunto - sin el parámetro (o vacío), exportan todas las
  // geocercas activas, igual que antes (compatible con enlaces ya
  // existentes que usen la ruta directa sin selección).
  function resolveGeofences(req: express.Request) {
    const ids = String(req.query.ids || '')
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter(Number.isInteger);
    return ids.length > 0 ? geofenceRepo.findByIds(ids) : geofenceRepo.findAllActive();
  }

  // GeoJSON - formato principal, nativo en JS/QGIS/Leaflet/Mapbox.
  // `downloadAuthMiddleware` (no el `authMiddleware` estricto de las
  // demás rutas) porque el frontend dispara esto con un `<a href>`
  // real, no `fetch()` - un link no puede mandar un header
  // Authorization, así que acepta el token por query string.
  router.get('/export.geojson', downloadAuthMiddleware, canManage, async (req, res) => {
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

  // KML - formato usado en topografía/minería y Google Earth (mismo
  // motivo que export.geojson para usar downloadAuthMiddleware).
  router.get('/export.kml', downloadAuthMiddleware, canManage, async (req, res) => {
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

  // ── Importación - GeoJSON FeatureCollection o texto KML ─────────
  // Body: { format: 'geojson', data: <FeatureCollection> } o
  //       { format: 'kml', data: '<contenido del archivo .kml>' }
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

/**
 * Validación mínima de los campos requeridos según la forma -
 * evita persistir geometría malformada que rompería geometry.ts
 * al evaluarse en tiempo real contra las posiciones entrantes.
 */
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
