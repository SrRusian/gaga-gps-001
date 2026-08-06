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

interface SocketServerLike {
  broadcast(event: string, payload: unknown): void;
}

export interface GeofencesRouterDeps {
  geofenceRepo: GeofenceRepository;
  geofenceService: GeofenceAlertService;
  socketServer: SocketServerLike;
}

export function buildGeofencesRouter({
  geofenceRepo,
  geofenceService,
  socketServer,
}: GeofencesRouterDeps) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const geofences = await geofenceRepo.findAllActive();
      res.json(geofences);
    } catch (err) {
      console.error('❌ geofences.routes GET /:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo geocercas' });
    }
  });

  router.post('/', async (req, res) => {
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

      socketServer.broadcast('geofences:update', geofenceService.activeGeofences);
      res.status(201).json(geofence);
    } catch (err) {
      console.error('❌ geofences.routes POST /:', (err as Error).message);
      res.status(500).json({ error: 'Error creando geocerca' });
    }
  });

  router.patch('/:id', async (req, res) => {
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
      socketServer.broadcast('geofences:update', geofenceService.activeGeofences);

      res.json(geofence);
    } catch (err) {
      console.error('❌ geofences.routes PATCH /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error actualizando geocerca' });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      await geofenceRepo.delete(Number(req.params.id));
      geofenceService.removeGeofence(parseInt(req.params.id, 10));
      socketServer.broadcast('geofences:update', geofenceService.activeGeofences);
      res.json({ success: true });
    } catch (err) {
      console.error('❌ geofences.routes DELETE /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error eliminando geocerca' });
    }
  });

  // ── Exportación en formatos estándar ────────────────────────────
  // Ambas rutas aceptan ?ids=1,2,3 opcional para exportar solo un
  // subconjunto — sin el parámetro (o vacío), exportan todas las
  // geocercas activas, igual que antes (compatible con enlaces ya
  // existentes que usen la ruta directa sin selección).
  function resolveGeofences(req: express.Request) {
    const ids = String(req.query.ids || '')
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter(Number.isInteger);
    return ids.length > 0 ? geofenceRepo.findByIds(ids) : geofenceRepo.findAllActive();
  }

  // GeoJSON — formato principal, nativo en JS/QGIS/Leaflet/Mapbox
  router.get('/export.geojson', async (req, res) => {
    try {
      const geofences = await resolveGeofences(req);
      res.setHeader('Content-Type', 'application/geo+json');
      res.setHeader('Content-Disposition', 'attachment; filename="geocercas.geojson"');
      res.json(geofencesToGeoJSON(geofences));
    } catch (err) {
      console.error('❌ geofences.routes GET /export.geojson:', (err as Error).message);
      res.status(500).json({ error: 'Error exportando GeoJSON' });
    }
  });

  // KML — formato usado en topografía/minería y Google Earth
  router.get('/export.kml', async (req, res) => {
    try {
      const geofences = await resolveGeofences(req);
      res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
      res.setHeader('Content-Disposition', 'attachment; filename="geocercas.kml"');
      res.send(geofencesToKml(geofences));
    } catch (err) {
      console.error('❌ geofences.routes GET /export.kml:', (err as Error).message);
      res.status(500).json({ error: 'Error exportando KML' });
    }
  });

  // ── Importación — GeoJSON FeatureCollection o texto KML ─────────
  // Body: { format: 'geojson', data: <FeatureCollection> } o
  //       { format: 'kml', data: '<contenido del archivo .kml>' }
  router.post('/import', async (req, res) => {
    try {
      const { format, data } = req.body;

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
        const geofence = await geofenceRepo.create(input);
        geofenceService.addGeofence(GeofenceRepository.toMemoryFormat(geofence));
        created.push(geofence);
      }

      if (created.length > 0) {
        socketServer.broadcast('geofences:update', geofenceService.activeGeofences);
      }

      res.status(created.length > 0 ? 201 : 400).json({
        imported: created.length,
        skipped: errors.length,
        errors,
        geofences: created,
      });
    } catch (err) {
      console.error('❌ geofences.routes POST /import:', (err as Error).message);
      res
        .status(500)
        .json({ error: 'Error importando geocercas — verifique el formato del archivo' });
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
 * Validación mínima de los campos requeridos según la forma —
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
