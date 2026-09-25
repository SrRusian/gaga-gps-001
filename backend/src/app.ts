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
import AppReleaseRepository from './repositories/AppReleaseRepository';
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
import InfractionRepository from './repositories/InfractionRepository';
import SystemSettingsRepository from './repositories/SystemSettingsRepository';
import DeviceProjectHistoryRepository from './repositories/DeviceProjectHistoryRepository';
import UserProjectHistoryRepository from './repositories/UserProjectHistoryRepository';
import DeviceGroupRepository from './repositories/DeviceGroupRepository';
import VehicleTypeRepository from './repositories/VehicleTypeRepository';
import EquipmentVariableRepository from './repositories/EquipmentVariableRepository';
import EquipmentActivityRepository from './repositories/EquipmentActivityRepository';
import ProductionRecordRepository from './repositories/ProductionRecordRepository';
import PayRateRepository from './repositories/PayRateRepository';

// ── Servicios de seguridad - NO se modifican, solo se integran ─
import GeofenceAlertService from './services/alerts/GeofenceAlertService';
import SignalLostService from './services/alerts/SignalLostService';
import CollisionRiskService from './services/alerts/CollisionRiskService';
import VehicleProximityService from './services/alerts/VehicleProximityService';
import SpeedAlertService from './services/alerts/SpeedAlertService';
import IncidentAlertService from './services/alerts/IncidentAlertService';
import PreventiveStopService from './services/alerts/PreventiveStopService';
import StaticEquipmentManager from './services/static_equipment/StaticEquipmentManager';

// ── Servicios de telemetría propios (reemplazan TraccarWsClient) ─
import FleetStateManager from './services/telemetry/FleetStateManager';
import DeviceManager from './services/telemetry/DeviceManager';
import PositionProcessor from './services/telemetry/PositionProcessor';
import PositionFilterService from './services/telemetry/PositionFilterService';
import SpeedEstimationService from './services/telemetry/SpeedEstimationService';
import ActivityClassificationService from './services/telemetry/ActivityClassificationService';
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
import buildAppUpdateRouter from './api/routes/app-update.routes';
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
import buildDeviceEventsRouter from './api/routes/device-events.routes';
import buildInfractionsRouter from './api/routes/infractions.routes';
import buildSettingsRouter from './api/routes/settings.routes';
import buildDeviceGroupsRouter from './api/routes/device-groups.routes';
import buildVehicleTypesRouter from './api/routes/vehicle-types.routes';
import buildEquipmentVariablesRouter from './api/routes/equipment-variables.routes';
import buildPowerEventsRouter from './api/routes/power-events.routes';
import buildProductionRouter from './api/routes/production.routes';
import MapPipelineService from './services/maps/MapPipelineService';

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // mismo orden que el cliente (web/packages/client/src/socket.ts) - polling primero, upgrade a
  // websocket despues, para evitar el warning de WebSocket abortado bajo StrictMode en dev
  transports: ['polling', 'websocket'],
});

// la app nativa Android (Capacitor) sirve el WebView desde su propio origen local (https://localhost),
// distinto del backend real - sin esto el navegador bloquea toda la API por CORS. Bearer token, no
// cookies, asi que origin abierto es seguro (mismo criterio ya usado en el cors de socket.io arriba)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// bug real reportado: express.json() sin limite explicito usa el default de 100kb - un KML de
// geocercas de apenas ~100KB en crudo ya lo pasaba (el JSON que lo envuelve infla el tamano por
// el escapado de comillas/saltos de linea), respondiendo 413 sin ninguna relacion con Google ni
// con el navegador. Mismo criterio generoso que ya se usa para mapas/APK (multer, limites propios
// via MAX_MAP_UPLOAD_MB/MAX_APK_UPLOAD_MB) - esta ruta solo necesita cubrir KML/GeoJSON de
// geocercas, pero se sube el limite global (aplica a toda la API) para no tener que acordarse de
// codificar cada endpoint nuevo que reciba texto largo por separado.
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(requestLogger);

// ── Repositorios ────────────────────────────────────────────────
const deviceRepo = new DeviceRepository();
const appReleaseRepo = new AppReleaseRepository();
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
const vehicleTypeRepo = new VehicleTypeRepository();
const equipmentVariableRepo = new EquipmentVariableRepository();
const equipmentActivityRepo = new EquipmentActivityRepository();
const productionRecordRepo = new ProductionRecordRepository();
const payRateRepo = new PayRateRepository();
const alertEventRepo = new AlertEventRepository();
const infractionRepo = new InfractionRepository();

const authMiddleware = buildAuthMiddleware({ userRepo });
const downloadAuthMiddleware = buildDownloadAuthMiddleware({ userRepo });
io.use(buildSocketAuthMiddleware({ userRepo }));

// antes de los servicios de seguridad - SignalLostService lo necesita para persistir status=offline
const deviceManager = new DeviceManager({ deviceRepo });

// ── Servicios de seguridad ──────────────────────────────────────
// socketServer se asigna después - evita ciclo con FleetSocketServer (mismo patrón que incidentAlertService abajo)
const geofenceService = new GeofenceAlertService({
  geofenceRepo,
  geofenceEventRepo,
  alertEventRepo,
  infractionRepo,
});
const preventiveStopService = new PreventiveStopService({ io, alertEventRepo });
// socketServer se asigna después - evita ciclo con FleetSocketServer (mismo patrón que geofenceService abajo)
const signalLostService = new SignalLostService({
  preventiveStopService,
  deviceManager,
  alertEventRepo,
});
const collisionService = new CollisionRiskService({ io, alertEventRepo, infractionRepo, geofenceRepo });
const proximityService = new VehicleProximityService({ io, alertEventRepo });
// socketServer se asigna después, mismo patrón que geofenceService (evita ciclo con FleetSocketServer)
const speedAlertService = new SpeedAlertService({ deviceRepo, alertEventRepo, infractionRepo });
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
  deviceRepo,
});
// mismo patrón de ciclo evitado que socketServer.incidentAlertService abajo
geofenceService.socketServer = socketServer;
speedAlertService.socketServer = socketServer;
signalLostService.socketServer = socketServer;
collisionService.socketServer = socketServer;

const positionFilter = new PositionFilterService(env.positionFilter);
const speedEstimator = new SpeedEstimationService();
const activityClassificationService = new ActivityClassificationService({
  operatorSessionRepo,
  equipmentActivityRepo,
});

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
  speedAlertService,
  activityClassificationService,
  deviceFootprintRepo: deviceRepo,
});

// ── UI estática ──────────────────────────────────────────────────
// una sola SPA - rutas por rol las resuelve React Router, no Express
// runtime detecta dist/ (Docker, ya aplanado) vs código fuente (tsx/node sin Docker) -
// sin esto express.static servía el index.html fuente y daba pantalla en blanco (bug real)
const webAppRoot = path.join(__dirname, '../../web');
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
// 2 niveles arriba (dist->backend->raíz) desde que backend/ dejo de vivir bajo apps/ - con 3
// (valor de cuando era apps/backend/dist) resolvía fuera de /app y los mapas importados se
// perdían al rebuildear
const resolvedMapsDir = path.join(__dirname, '../../', env.mapsDir);
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
app.use('/api/auth', authLimiter, buildAuthRouter({ userRepo, authMiddleware }));

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
    speedAlertService,
    activityClassificationService,
    incidentAlertService,
    equipmentRepo,
    equipmentManager,
    deviceProjectHistoryRepo,
    socketServer,
    headingTracker: positionProcessor.headingTracker,
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
  buildReportsRouter({
    positionRepo,
    geofenceRepo,
    deviceRepo,
    equipmentActivityRepo,
    operatorSessionRepo,
    requireRole,
  }),
);
app.use(
  '/api/incidents',
  buildIncidentsRouter({ incidentAlertService, incidentRepo, deviceRepo, authMiddleware, requireRole }),
);
app.use(
  '/api/alerts',
  authMiddleware,
  buildAlertsRouter({ alertEventRepo, requireRole, geofenceEventRepo }),
);
// lo que la TABLETA decide por su cuenta (velocidad, zona) - autenticado con la sesion del
// operador, sin restriccion de rol: el unico que llama esto es la propia tableta
app.use(
  '/api/alerts',
  authMiddleware,
  buildDeviceEventsRouter({
    alertEventRepo,
    infractionRepo,
    geofenceEventRepo,
    deviceRepo,
    socketServer,
    signalLostService,
  }),
);
app.use('/api/infractions', buildInfractionsRouter({ infractionRepo, authMiddleware, requireRole }));
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
app.use('/api/vehicle-types', buildVehicleTypesRouter({ vehicleTypeRepo, authMiddleware, requireRole }));
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
// clave compartida, no JWT - ver power-events.routes.ts
app.use(
  '/api/power-events',
  buildPowerEventsRouter({ deviceRepo, geofenceRepo, alertEventRepo, signalLostService, socketServer }),
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
    activityClassificationService,
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

// ── Distribucion de APK (auto-actualizacion sin Play Store) ─────
const resolvedReleasesDir = path.join(__dirname, '../../', env.releasesDir);
app.use(
  '/api/app',
  buildAppUpdateRouter({
    releasesDir: resolvedReleasesDir,
    appReleaseRepo,
    deviceRepo,
    socketServer,
    authMiddleware,
    requireRole,
  }),
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
  console.warn(` Usuario admin creado automáticamente (primera vez): ${env.defaultAdminEmail}`);
  console.warn(' Contraseña: la definida por DEFAULT_ADMIN_PASSWORD en el .env de este servidor');
  console.warn(' (no se imprime aquí por seguridad - no queda en los logs).');
  console.warn(' Inicia sesión en / y CAMBIA esta contraseña de inmediato.');
  console.warn(' ══════════════════════════════════════════════════════════');
}

// claves de system_settings -> como aplicarlas a env.ntripDefault - mismo criterio que
// telemetrySharedSecret (DB gana sobre .env en cuanto un admin guarda una vez desde Sistema)
const NTRIP_SETTING_APPLIERS: Array<[key: string, apply: (value: string) => void]> = [
  ['ntripDefaultName', (v) => (env.ntripDefault.name = v || 'Principal')],
  ['ntripDefaultHost', (v) => (env.ntripDefault.host = v || null)],
  ['ntripDefaultPort', (v) => (env.ntripDefault.port = parseInt(v, 10) || 2101)],
  ['ntripDefaultUsername', (v) => (env.ntripDefault.username = v || null)],
  ['ntripDefaultPassword', (v) => (env.ntripDefault.password = v || null)],
  ['ntripDefaultMountpoint', (v) => (env.ntripDefault.mountpoint = v || null)],
  ['ntripDefaultVersion', (v) => (env.ntripDefault.version = v === 'v1' ? 'v1' : 'v2')],
];

async function loadSettingsOverrides(): Promise<void> {
  const stored = await settingsRepo.get('telemetrySharedSecret');
  if (stored !== null) env.telemetrySharedSecret = stored;

  for (const [key, apply] of NTRIP_SETTING_APPLIERS) {
    const value = await settingsRepo.get(key);
    if (value !== null) apply(value);
  }
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
      .map((d) => ({ deviceId: d.unique_id, lastSeenAt: d.last_update as Date, projectId: d.project_id }));
    signalLostService.hydrate(staleTrackedDevices);
    console.log(
      `${staleTrackedDevices.length} dispositivo(s) "online" recuperado(s) para monitoreo de señal`,
    );

    // signal_lost/collision/proximity dependen 100% de estado en memoria (alertLevel/collisionAlerts/
    // proximityAlerts) que un reinicio del proceso borra - sin esto una fila abierta antes del reinicio
    // queda "activa" para siempre aunque el vehiculo ya lleve horas bien. Los detectores re-abren de
    // inmediato si el problema sigue siendo real (checkAllDevices cada 5s, colision/proximity en la
    // siguiente posicion real).
    for (const alertType of ['signal_lost', 'collision', 'proximity', 'restricted_zone'] as const) {
      const closed = await alertEventRepo.resolveAllOpenOfType(alertType);
      if (closed > 0) {
        console.log(`${closed} alerta(s) '${alertType}' abierta(s) antes del reinicio, cerrada(s) al arrancar`);
      }
    }

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
