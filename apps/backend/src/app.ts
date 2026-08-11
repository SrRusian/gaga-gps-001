/**
 * Las tabletas (Traccar Client) reportan directamente a GET /gps
 * usando el protocolo OsmAnd. Este archivo solo ensambla config,
 * repositorios, servicios y rutas — la lógica vive en cada módulo.
 */
import './config/loadEnv';
import bcrypt from 'bcryptjs';
import express from 'express';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';

import { db, env, redis } from './config';

// ── Repositorios ───────────────────────────────────────────────
import DeviceRepository from './repositories/DeviceRepository';
import PositionRepository from './repositories/PositionRepository';
import DeviceSensorRepository from './repositories/DeviceSensorRepository';
import GeofenceRepository from './repositories/GeofenceRepository';
import GeofenceEventRepository from './repositories/GeofenceEventRepository';
import EquipmentRepository from './repositories/EquipmentRepository';
import UserRepository from './repositories/UserRepository';
import OperatorSessionRepository from './repositories/OperatorSessionRepository';
import MapRepository from './repositories/MapRepository';

// ── Servicios de seguridad — NO se modifican, solo se integran ─
import GeofenceAlertService from './services/alerts/GeofenceAlertService';
import SignalLostService from './services/alerts/SignalLostService';
import CollisionRiskService from './services/alerts/CollisionRiskService';
import VehicleProximityService from './services/alerts/VehicleProximityService';
import PreventiveStopService from './services/alerts/PreventiveStopService';
import StaticEquipmentManager from './services/static_equipment/StaticEquipmentManager';

// ── Servicios de telemetría propios (reemplazan TraccarWsClient) ─
import FleetStateManager from './services/telemetry/FleetStateManager';
import DeviceManager from './services/telemetry/DeviceManager';
import PositionProcessor from './services/telemetry/PositionProcessor';
import PositionFilterService from './services/telemetry/PositionFilterService';
import SpeedEstimationService from './services/telemetry/SpeedEstimationService';
import FleetSocketServer from './sockets/FleetSocketServer';

// ── Middleware ──────────────────────────────────────────────────
import {
  buildAuthMiddleware,
  buildSocketAuthMiddleware,
  requireRole,
} from './api/middleware/auth.middleware';
import { telemetryLimiter, authLimiter } from './api/middleware/rateLimiter';
import { requestLogger } from './api/middleware/logger';

// ── Rutas ───────────────────────────────────────────────────────
import buildTelemetryRouter from './api/routes/telemetry.routes';
import buildAuthRouter from './api/routes/auth.routes';
import buildDevicesRouter from './api/routes/devices.routes';
import buildGeofencesRouter from './api/routes/geofences.routes';
import buildEquipmentRouter from './api/routes/equipment.routes';
import buildFleetRouter from './api/routes/fleet.routes';
import buildMapsRouter from './api/routes/maps.routes';
import buildMapsAdminRouter from './api/routes/maps-admin.routes';
import buildReportsRouter from './api/routes/reports.routes';
import buildUsersRouter from './api/routes/users.routes';
import buildOperatorSessionsRouter from './api/routes/operator-sessions.routes';
import buildDeviceSensorsRouter from './api/routes/device-sensors.routes';
import MapPipelineService from './services/maps/MapPipelineService';

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

// ── Repositorios ────────────────────────────────────────────────
const deviceRepo = new DeviceRepository();
const positionRepo = new PositionRepository();
const geofenceRepo = new GeofenceRepository();
const geofenceEventRepo = new GeofenceEventRepository();
const equipmentRepo = new EquipmentRepository();
const userRepo = new UserRepository();
const operatorSessionRepo = new OperatorSessionRepository();
const mapRepo = new MapRepository();
const sensorRepo = new DeviceSensorRepository();

const authMiddleware = buildAuthMiddleware({ userRepo });
io.use(buildSocketAuthMiddleware({ userRepo }));

// Se crea antes que los servicios de seguridad porque SignalLostService
// lo necesita para marcar `devices.status='offline'` en PostgreSQL en
// cuanto se detecta pérdida de señal (ver más abajo) — antes esa
// transición nunca se persistía y el panel admin quedaba mostrando
// "online" indefinidamente.
const deviceManager = new DeviceManager({ deviceRepo });

// ── Servicios de seguridad ──────────────────────────────────────
const geofenceService = new GeofenceAlertService({ io, geofenceEventRepo });
const preventiveStopService = new PreventiveStopService({ io });
const signalLostService = new SignalLostService({ io, preventiveStopService, deviceManager });
const collisionService = new CollisionRiskService({ io });
const proximityService = new VehicleProximityService({ io });
const equipmentManager = new StaticEquipmentManager({ io });

// ── Telemetría propia ───────────────────────────────────────────
const fleetState = new FleetStateManager(redis.redis);
const socketServer = new FleetSocketServer({
  io,
  fleetState,
  geofenceService,
  preventiveStopService,
  mapRepo,
});
const positionFilter = new PositionFilterService(env.positionFilter);
const speedEstimator = new SpeedEstimationService();

const positionProcessor = new PositionProcessor({
  positionRepo,
  fleetState,
  socketServer,
  deviceManager,
  geofenceService,
  signalLostService,
  collisionService,
  proximityService,
  equipmentManager,
  positionFilter,
  speedEstimator,
});

// ── UI estática ──────────────────────────────────────────────────
// Una sola SPA (apps/web-app) — el login y las 3 vistas por rol
// (/admin, /supervisor, /operator) los resuelve React Router del
// lado del cliente, no Express. express.static intenta servir un
// archivo real primero (JS/CSS/imágenes ya compilados); si no
// existe, sigue a las rutas de abajo, y el fallback de SPA al final
// del archivo sirve siempre index.html para cualquier ruta de
// navegación que no sea un archivo ni una API.
const webAppDir = path.join(__dirname, '../../web-app');
app.use(express.static(webAppDir));

// ── Receptor de telemetría — GET /gps (protocolo OsmAnd) ────────
app.use(telemetryLimiter, buildTelemetryRouter({ positionProcessor }));

// ── Tiles MBTiles / importador de mapas satelitales ───────────────
const resolvedMapsDir = path.join(__dirname, '../../', env.mapsDir);
const mapsRouter = buildMapsRouter({ mapsDir: resolvedMapsDir, mapRepo });
const mapPipelineService = new MapPipelineService({ mapsDir: resolvedMapsDir, mapRepo });

app.use('/tiles', mapsRouter);
app.use(
  '/api/maps',
  authMiddleware,
  requireRole('admin'),
  buildMapsAdminRouter({
    mapRepo,
    mapPipelineService,
    mapsDir: resolvedMapsDir,
    invalidateTilesCache: mapsRouter.invalidateCache,
    socketServer,
  }),
);

// ── Autenticación ────────────────────────────────────────────────
app.use('/api/auth', authLimiter, buildAuthRouter({ userRepo }));

// ── API REST protegida (panel admin) ─────────────────────────────
app.use(
  '/api/devices',
  buildDevicesRouter({ deviceRepo, operatorSessionRepo, authMiddleware, fleetState }),
);
app.use(
  '/api/geofences',
  authMiddleware,
  buildGeofencesRouter({ geofenceRepo, geofenceService, socketServer }),
);
app.use(
  '/api/equipment',
  authMiddleware,
  buildEquipmentRouter({ equipmentRepo, equipmentManager, socketServer }),
);
app.use('/api/reports', authMiddleware, buildReportsRouter({ positionRepo, geofenceRepo }));
app.use('/api/users', authMiddleware, requireRole('admin'), buildUsersRouter({ userRepo }));

app.use(
  '/api/operator-sessions',
  buildOperatorSessionsRouter({ operatorSessionRepo, authMiddleware, requireRole }),
);
app.use(
  '/api/devices',
  buildDeviceSensorsRouter({ sensorRepo, authMiddleware, requireRole }),
);

app.use(
  '/api/fleet',
  buildFleetRouter({ preventiveStopService, fleetState, authMiddleware, requireRole }),
);

// ── Health check ───────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const [pgOk, redisOk] = await Promise.all([db.checkConnection(), redis.checkConnection()]);
  res.json({
    status: pgOk && redisOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      postgres: pgOk ? 'connected' : 'disconnected',
      redis: redisOk ? 'connected' : 'disconnected',
      preventiveStop: preventiveStopService.getStatus(),
    },
  });
});

// ── Fallback de SPA ───────────────────────────────────────────────
// Debe ir al final, después de todas las rutas de arriba — cualquier
// GET que no sea un archivo real (ya lo habría servido
// express.static) ni una de las rutas anteriores (/gps, /tiles,
// /api/*, /health) es una ruta de navegación de React Router
// (/, /admin, /supervisor, /operator, o una sub-ruta futura) y debe
// resolver siempre a index.html para que el router del cliente la
// tome. Se excluye /socket.io explícitamente — Socket.io intercepta
// esas peticiones por su cuenta (vía engine.io), antes de que
// Express decida qué hacer con ellas.
app.get(/^\/(?!api|gps|tiles|health|socket\.io).*/, (req, res) => {
  res.sendFile(path.join(webAppDir, 'index.html'));
});

/**
 * Crea el usuario admin@gaga.com (o el que se configure vía
 * DEFAULT_ADMIN_EMAIL) con la contraseña por defecto SOLO si la
 * tabla `users` está completamente vacía — o sea, la primera vez
 * que se levanta el volumen de PostgreSQL. Evita el paso manual de
 * `npm run seed:admin` en una instalación nueva; el script sigue
 * disponible para crear usuarios adicionales o resetear la
 * contraseña más adelante.
 */
async function ensureDefaultAdmin(): Promise<void> {
  const existing = await userRepo.findAll();
  if (existing.length > 0) return;

  const passwordHash = await bcrypt.hash(env.defaultAdminPassword, 10);
  await userRepo.create({
    email: env.defaultAdminEmail,
    passwordHash,
    name: 'Administrador',
    role: 'admin',
  });

  console.warn('⚠️  ══════════════════════════════════════════════════════════');
  console.warn(
    `⚠️  Usuario admin creado automáticamente (primera vez): ${env.defaultAdminEmail} / ${env.defaultAdminPassword}`,
  );
  console.warn('⚠️  Inicia sesión en / y CAMBIA esta contraseña de inmediato.');
  console.warn('⚠️  ══════════════════════════════════════════════════════════');
}

async function loadPersistedState(): Promise<void> {
  try {
    await ensureDefaultAdmin();

    const geofences = await geofenceRepo.findAllActive();
    geofences.forEach((g) => geofenceService.addGeofence(GeofenceRepository.toMemoryFormat(g)));
    console.log(`✅ ${geofences.length} geocerca(s) cargada(s) desde PostgreSQL`);

    // Recupera el reloj de "última señal" de los dispositivos que
    // quedaron marcados online antes de este reinicio — así
    // SignalLostService los re-evalúa de inmediato en vez de
    // olvidarlos (ver comentario en SignalLostService.hydrate).
    const devices = await deviceRepo.findAll();
    const staleTrackedDevices = devices
      .filter((d) => d.status === 'online' && d.last_update)
      .map((d) => ({ deviceId: d.unique_id, lastSeenAt: d.last_update as Date }));
    signalLostService.hydrate(staleTrackedDevices);
    console.log(
      `✅ ${staleTrackedDevices.length} dispositivo(s) "online" recuperado(s) para monitoreo de señal`,
    );

    const equipment = await equipmentRepo.findAll();
    equipment.forEach((eq) =>
      equipmentManager.registerEquipment({
        id: eq.id,
        name: eq.name,
        type: eq.type,
        lat: eq.latitude,
        lon: eq.longitude,
        swingRadius: eq.swing_radius,
        safetyRadius: eq.safety_radius,
        status: eq.status,
      }),
    );
    console.log(`✅ ${equipment.length} equipo(s) estático(s) cargado(s) desde PostgreSQL`);
  } catch (err) {
    console.error('❌ Error cargando estado persistido:', (err as Error).message);
  }
}

// ── Servidor ───────────────────────────────────────────────────
const PORT = env.port;

loadPersistedState().finally(() => {
  signalLostService.startMonitoring();

  const closeStale = () => {
    operatorSessionRepo.closeStaleSessions(env.operatorSessionMaxIdleDays).catch((err: Error) => {
      console.error('❌ Error cerrando turnos inactivos:', err.message);
    });
  };
  closeStale();
  setInterval(closeStale, 6 * 60 * 60 * 1000);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Backend GAGA-GPS v2.0 (sistema propio) corriendo en puerto ${PORT}`);
    console.log(`   Telemetría: GET http://localhost:${PORT}/gps`);
    console.log(
      `   Login:      http://localhost:${PORT}/ (redirige a /admin, /supervisor u /operator según el rol)`,
    );
    console.log(`   Health:     http://localhost:${PORT}/health`);
  });
});

export { app, server, io };
