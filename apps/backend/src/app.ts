// GET /gps recibe telemetría de tabletas (Traccar Client, protocolo OsmAnd)
import './config/loadEnv';
import bcrypt from 'bcryptjs';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';

import { db, env, redis } from './config';

// ── Repositorios ───────────────────────────────────────────────
import DeviceRepository from './repositories/DeviceRepository';
import PositionRepository from './repositories/PositionRepository';
import DeviceSensorRepository from './repositories/DeviceSensorRepository';
import ProjectRepository from './repositories/ProjectRepository';
import GeofenceRepository from './repositories/GeofenceRepository';
import GeofenceEventRepository from './repositories/GeofenceEventRepository';
import EquipmentRepository from './repositories/EquipmentRepository';
import UserRepository from './repositories/UserRepository';
import OperatorSessionRepository from './repositories/OperatorSessionRepository';
import MapRepository from './repositories/MapRepository';
import ShiftRepository from './repositories/ShiftRepository';
import IncidentReportRepository from './repositories/IncidentReportRepository';
import AlertEventRepository from './repositories/AlertEventRepository';
import SystemSettingsRepository from './repositories/SystemSettingsRepository';
import DeviceProjectHistoryRepository from './repositories/DeviceProjectHistoryRepository';
import UserProjectHistoryRepository from './repositories/UserProjectHistoryRepository';
import DeviceGroupRepository from './repositories/DeviceGroupRepository';
import EquipmentVariableRepository from './repositories/EquipmentVariableRepository';
import EquipmentActivityRepository from './repositories/EquipmentActivityRepository';
import ProductionRecordRepository from './repositories/ProductionRecordRepository';
import PayRateRepository from './repositories/PayRateRepository';

// ── Servicios de seguridad - NO se modifican, solo se integran ─
import GeofenceAlertService from './services/alerts/GeofenceAlertService';
import SignalLostService from './services/alerts/SignalLostService';
import CollisionRiskService from './services/alerts/CollisionRiskService';
import VehicleProximityService from './services/alerts/VehicleProximityService';
import IncidentAlertService from './services/alerts/IncidentAlertService';
import PreventiveStopService from './services/alerts/PreventiveStopService';
import StaticEquipmentManager from './services/static_equipment/StaticEquipmentManager';

// ── Servicios de telemetría propios (reemplazan TraccarWsClient) ─
import FleetStateManager from './services/telemetry/FleetStateManager';
import DeviceManager from './services/telemetry/DeviceManager';
import PositionProcessor from './services/telemetry/PositionProcessor';
import PositionFilterService from './services/telemetry/PositionFilterService';
import SpeedEstimationService from './services/telemetry/SpeedEstimationService';
import ShiftResolverService from './services/telemetry/ShiftResolverService';
import FleetSocketServer from './sockets/FleetSocketServer';

// ── Middleware ──────────────────────────────────────────────────
import {
  buildAuthMiddleware,
  buildDownloadAuthMiddleware,
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
import buildProjectsRouter from './api/routes/projects.routes';
import buildShiftsRouter from './api/routes/shifts.routes';
import buildIncidentsRouter from './api/routes/incidents.routes';
import buildAlertsRouter from './api/routes/alerts.routes';
import buildSettingsRouter from './api/routes/settings.routes';
import buildDeviceGroupsRouter from './api/routes/device-groups.routes';
import buildEquipmentVariablesRouter from './api/routes/equipment-variables.routes';
import buildProductionRouter from './api/routes/production.routes';
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
const projectRepo = new ProjectRepository();
const shiftRepo = new ShiftRepository();
const shiftResolver = new ShiftResolverService({ shiftRepo });
const incidentRepo = new IncidentReportRepository();
const settingsRepo = new SystemSettingsRepository();
const deviceProjectHistoryRepo = new DeviceProjectHistoryRepository();
const userProjectHistoryRepo = new UserProjectHistoryRepository();
const deviceGroupRepo = new DeviceGroupRepository();
const equipmentVariableRepo = new EquipmentVariableRepository();
const equipmentActivityRepo = new EquipmentActivityRepository();
const productionRecordRepo = new ProductionRecordRepository();
const payRateRepo = new PayRateRepository();
const alertEventRepo = new AlertEventRepository();

const authMiddleware = buildAuthMiddleware({ userRepo });
const downloadAuthMiddleware = buildDownloadAuthMiddleware({ userRepo });
io.use(buildSocketAuthMiddleware({ userRepo }));

// antes de los servicios de seguridad - SignalLostService lo necesita para persistir status=offline
const deviceManager = new DeviceManager({ deviceRepo });

// ── Servicios de seguridad ──────────────────────────────────────
// socketServer se asigna después - evita ciclo con FleetSocketServer (mismo patrón que incidentAlertService abajo)
const geofenceService = new GeofenceAlertService({ geofenceRepo, geofenceEventRepo, alertEventRepo });
const preventiveStopService = new PreventiveStopService({ io, alertEventRepo });
const signalLostService = new SignalLostService({
  io,
  preventiveStopService,
  deviceManager,
  alertEventRepo,
});
const collisionService = new CollisionRiskService({ io, alertEventRepo });
const proximityService = new VehicleProximityService({ io, alertEventRepo });
const equipmentManager = new StaticEquipmentManager({ io });

// ── Telemetría propia ───────────────────────────────────────────
const fleetState = new FleetStateManager(redis.redis);
const socketServer = new FleetSocketServer({
  io,
  fleetState,
  geofenceService,
  preventiveStopService,
  mapRepo,
  alertEventRepo,
  equipmentManager,
});
// mismo patrón de ciclo evitado que socketServer.incidentAlertService abajo
geofenceService.socketServer = socketServer;

const positionFilter = new PositionFilterService(env.positionFilter);
const speedEstimator = new SpeedEstimationService();

// usa socketServer.broadcastToProject (no io directo) - incidentes ya traen su project_id
const incidentAlertService = new IncidentAlertService({ socketServer, incidentRepo, alertEventRepo });
// asignado post-construcción para evitar ciclo con socketServer (ver FleetSocketServer.ts)
socketServer.incidentAlertService = incidentAlertService;

const positionProcessor = new PositionProcessor({
  positionRepo,
  fleetState,
  socketServer,
  deviceManager,
  geofenceService,
  signalLostService,
  collisionService,
  proximityService,
  incidentAlertService,
  equipmentManager,
  positionFilter,
  speedEstimator,
});

// ── UI estática ──────────────────────────────────────────────────
// una sola SPA - rutas por rol las resuelve React Router, no Express
// runtime detecta dist/ (Docker, ya aplanado) vs código fuente (tsx/node sin Docker) -
// sin esto express.static servía el index.html fuente y daba pantalla en blanco (bug real)
const webAppRoot = path.join(__dirname, '../../web-app');
const webAppDistDir = path.join(webAppRoot, 'dist');
const webAppDir = fs.existsSync(path.join(webAppDistDir, 'index.html')) ? webAppDistDir : webAppRoot;
// index.html sin cache - si no, un F5 puede seguir sirviendo una build vieja desde el cache del
// navegador; los assets de Vite sí llevan hash en el nombre, esos cachean fuerte sin problema
app.use(
  express.static(webAppDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }),
);

// ── Receptor de telemetría - GET /gps (protocolo OsmAnd) ────────
app.use(telemetryLimiter, buildTelemetryRouter({ positionProcessor }));

// ── Tiles MBTiles / importador de mapas satelitales ───────────────
// 3 niveles arriba (dist->backend->apps->raíz), no 2 - con 2 resolvía a apps/maps
// (efímero, fuera del volumen maps_data) y los mapas importados se perdían al rebuildear
const resolvedMapsDir = path.join(__dirname, '../../../', env.mapsDir);
const mapsRouter = buildMapsRouter({ mapsDir: resolvedMapsDir, mapRepo, userRepo });
const mapPipelineService = new MapPipelineService({ mapsDir: resolvedMapsDir, mapRepo });

app.use('/tiles', mapsRouter);
app.use(
  '/api/maps',
  authMiddleware,
  buildMapsAdminRouter({
    mapRepo,
    mapPipelineService,
    mapsDir: resolvedMapsDir,
    invalidateTilesCache: mapsRouter.invalidateCache,
    socketServer,
    requireRole,
  }),
);

// ── Autenticación ────────────────────────────────────────────────
app.use('/api/auth', authLimiter, buildAuthRouter({ userRepo }));

// ── API REST protegida (panel admin) ─────────────────────────────
app.use(
  '/api/projects',
  authMiddleware,
  requireRole('admin', 'project_administrator'),
  buildProjectsRouter({
    projectRepo,
    mapRepo,
    mapPipelineService,
    mapsDir: resolvedMapsDir,
    invalidateTilesCache: mapsRouter.invalidateCache,
    socketServer,
    requireRole,
  }),
);
app.use(
  '/api/shifts',
  authMiddleware,
  buildShiftsRouter({ shiftRepo, operatorSessionRepo, requireRole }),
);
app.use(
  '/api/devices',
  buildDevicesRouter({
    deviceRepo,
    operatorSessionRepo,
    authMiddleware,
    requireRole,
    fleetState,
    geofenceAlertService: geofenceService,
    signalLostService,
    collisionRiskService: collisionService,
    vehicleProximityService: proximityService,
    incidentAlertService,
    equipmentRepo,
    equipmentManager,
    deviceProjectHistoryRepo,
    socketServer,
  }),
);
app.use(
  '/api/geofences',
  buildGeofencesRouter({
    geofenceRepo,
    geofenceService,
    socketServer,
    authMiddleware,
    downloadAuthMiddleware,
    requireRole,
  }),
);
app.use(
  '/api/equipment',
  authMiddleware,
  buildEquipmentRouter({ equipmentRepo, equipmentManager, socketServer, requireRole }),
);
app.use(
  '/api/reports',
  authMiddleware,
  buildReportsRouter({ positionRepo, geofenceRepo, deviceRepo, requireRole }),
);
app.use(
  '/api/incidents',
  buildIncidentsRouter({ incidentAlertService, incidentRepo, deviceRepo, authMiddleware, requireRole }),
);
app.use(
  '/api/alerts',
  authMiddleware,
  buildAlertsRouter({ alertEventRepo, requireRole, shiftResolver }),
);
// chequeo de rol por-ruta dentro del router, no aquí - ver users.routes.ts
app.use(
  '/api/users',
  authMiddleware,
  buildUsersRouter({ userRepo, requireRole, userProjectHistoryRepo }),
);
app.use('/api/settings', buildSettingsRouter({ settingsRepo, authMiddleware, requireRole }));
app.use(
  '/api/device-groups',
  authMiddleware,
  buildDeviceGroupsRouter({ deviceGroupRepo, requireRole }),
);
// clave compartida en POST /, no JWT - ver equipment-variables.routes.ts
app.use(
  '/api/equipment-variables',
  buildEquipmentVariablesRouter({
    equipmentVariableRepo,
    deviceRepo,
    alertEventRepo,
    authMiddleware,
    requireRole,
  }),
);
app.use(
  '/api/production',
  buildProductionRouter({
    equipmentActivityRepo,
    productionRecordRepo,
    payRateRepo,
    authMiddleware,
    requireRole,
  }),
);

app.use(
  '/api/operator-sessions',
  buildOperatorSessionsRouter({
    operatorSessionRepo,
    deviceRepo,
    equipmentRepo,
    equipmentManager,
    socketServer,
    shiftResolver,
    authMiddleware,
    requireRole,
  }),
);
app.use(
  '/api/devices',
  buildDeviceSensorsRouter({ sensorRepo, deviceRepo, authMiddleware, requireRole }),
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
// debe ir al final - resuelve rutas de React Router a index.html; excluye /socket.io (lo maneja engine.io)
app.get(/^\/(?!api|gps|tiles|health|socket\.io).*/, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(webAppDir, 'index.html'));
});

// crea admin por defecto solo si users está vacía (primer arranque) - seed:admin sigue disponible aparte
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

  console.warn(' ══════════════════════════════════════════════════════════');
  console.warn(
    ` Usuario admin creado automáticamente (primera vez): ${env.defaultAdminEmail} / ${env.defaultAdminPassword}`,
  );
  console.warn(' Inicia sesión en / y CAMBIA esta contraseña de inmediato.');
  console.warn(' ══════════════════════════════════════════════════════════');
}

async function loadSettingsOverrides(): Promise<void> {
  const stored = await settingsRepo.get('telemetrySharedSecret');
  if (stored !== null) env.telemetrySharedSecret = stored;
}

async function loadPersistedState(): Promise<void> {
  try {
    await ensureDefaultAdmin();
    await loadSettingsOverrides();

    const geofences = await geofenceRepo.findAllActive();
    geofences.forEach((g) => geofenceService.addGeofence(GeofenceRepository.toMemoryFormat(g)));
    console.log(`${geofences.length} geocerca(s) cargada(s) desde PostgreSQL`);

    // recupera last_update de dispositivos "online" antes del reinicio para que SignalLostService los re-evalúe
    const devices = await deviceRepo.findAll();
    const staleTrackedDevices = devices
      .filter((d) => d.status === 'online' && d.last_update)
      .map((d) => ({ deviceId: d.unique_id, lastSeenAt: d.last_update as Date }));
    signalLostService.hydrate(staleTrackedDevices);
    console.log(
      `${staleTrackedDevices.length} dispositivo(s) "online" recuperado(s) para monitoreo de señal`,
    );

    const equipment = await equipmentRepo.findAll();
    equipment.forEach((eq) =>
      equipmentManager.registerEquipment({
        id: eq.id,
        projectId: eq.project_id,
        name: eq.name,
        type: eq.type,
        lat: eq.latitude,
        lon: eq.longitude,
        swingRadius: eq.swing_radius,
        safetyRadius: eq.safety_radius,
        status: eq.status,
        linkedDeviceId: eq.linked_device_id,
      }),
    );
    console.log(`${equipment.length} equipo(s) estático(s) cargado(s) desde PostgreSQL`);

    await incidentAlertService.hydrate();
    console.log(
      `${Object.keys(incidentAlertService.activeIncidents).length} incidente(s) abierto(s) recuperado(s) desde PostgreSQL`,
    );
  } catch (err) {
    console.error('Error cargando estado persistido:', (err as Error).message);
  }
}

// ── Servidor ───────────────────────────────────────────────────
const PORT = env.port;

loadPersistedState().finally(() => {
  signalLostService.startMonitoring();

  const closeStale = () => {
    operatorSessionRepo.closeStaleSessions(env.operatorSessionMaxIdleDays).catch((err: Error) => {
      console.error('Error cerrando turnos inactivos:', err.message);
    });
  };
  closeStale();
  setInterval(closeStale, 6 * 60 * 60 * 1000);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend GAGA-GPS v2.0 (sistema propio) corriendo en puerto ${PORT}`);
    console.log(`   Telemetría: GET http://localhost:${PORT}/gps`);
    console.log(
      `   Login:      http://localhost:${PORT}/ (redirige a /administrator, /supervisor u /operator según el rol)`,
    );
    console.log(`   Health:     http://localhost:${PORT}/health`);
  });
});

export { app, server, io };
