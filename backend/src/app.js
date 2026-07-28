/**
 * app.js
 *
 * Entry point del backend GAGA-GPS-001 — sistema propio de
 * telemetría GPS (sin Traccar como intermediario).
 *
 * Las tabletas (Traccar Client) reportan directamente a GET /gps
 * usando el protocolo OsmAnd. Este archivo solo ensambla config,
 * repositorios, servicios y rutas — la lógica vive en cada módulo.
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const { env, db, redis } = require('./config');

// ── Repositorios ───────────────────────────────────────────────
const DeviceRepository = require('./repositories/DeviceRepository');
const PositionRepository = require('./repositories/PositionRepository');
const GeofenceRepository = require('./repositories/GeofenceRepository');
const EquipmentRepository = require('./repositories/EquipmentRepository');
const UserRepository = require('./repositories/UserRepository');

// ── Servicios de seguridad — NO se modifican, solo se integran ─
const GeofenceAlertService = require('./services/alerts/GeofenceAlertService');
const SignalLostService = require('./services/alerts/SignalLostService');
const CollisionRiskService = require('./services/alerts/CollisionRiskService');
const PreventiveStopService = require('./services/alerts/PreventiveStopService');
const StaticEquipmentManager = require('./services/static_equipment/StaticEquipmentManager');

// ── Servicios de telemetría propios (reemplazan TraccarWsClient) ─
const FleetStateManager = require('./services/telemetry/FleetStateManager');
const DeviceManager = require('./services/telemetry/DeviceManager');
const PositionProcessor = require('./services/telemetry/PositionProcessor');
const FleetSocketServer = require('./sockets/FleetSocketServer');

// ── Middleware ──────────────────────────────────────────────────
const { authMiddleware, requireRole } = require('./api/middleware/auth.middleware');
const { telemetryLimiter, authLimiter } = require('./api/middleware/rateLimiter');
const { requestLogger } = require('./api/middleware/logger');

// ── Rutas ───────────────────────────────────────────────────────
const buildTelemetryRouter = require('./api/routes/telemetry.routes');
const buildAuthRouter = require('./api/routes/auth.routes');
const buildDevicesRouter = require('./api/routes/devices.routes');
const buildGeofencesRouter = require('./api/routes/geofences.routes');
const buildEquipmentRouter = require('./api/routes/equipment.routes');
const buildFleetRouter = require('./api/routes/fleet.routes');
const buildMapsRouter = require('./api/routes/maps.routes');
const buildReportsRouter = require('./api/routes/reports.routes');
const buildUsersRouter = require('./api/routes/users.routes');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

app.use(express.json());
app.use(requestLogger);

// ── Repositorios ────────────────────────────────────────────────
const deviceRepo = new DeviceRepository();
const positionRepo = new PositionRepository();
const geofenceRepo = new GeofenceRepository();
const equipmentRepo = new EquipmentRepository();
const userRepo = new UserRepository();

// ── Servicios de seguridad ──────────────────────────────────────
const geofenceService = new GeofenceAlertService({ io });
const preventiveStopService = new PreventiveStopService({ io });
const signalLostService = new SignalLostService({ io, preventiveStopService });
const collisionService = new CollisionRiskService({ io });
const equipmentManager = new StaticEquipmentManager({ io });

// ── Telemetría propia ───────────────────────────────────────────
const fleetState = new FleetStateManager(redis.redis);
const deviceManager = new DeviceManager({ deviceRepo });
const socketServer = new FleetSocketServer({ io, fleetState, geofenceService, preventiveStopService });

const positionProcessor = new PositionProcessor({
  positionRepo,
  fleetState,
  socketServer,
  deviceManager,
  geofenceService,
  signalLostService,
  collisionService,
  equipmentManager
});

// ── UI estáticas ─────────────────────────────────────────────────
app.use('/operator', express.static(path.join(__dirname, '../ui-operator')));
app.use('/supervisor', express.static(path.join(__dirname, '../ui-supervisor')));
app.use('/admin', express.static(path.join(__dirname, '../ui-admin')));

// ── Receptor de telemetría — GET /gps (protocolo OsmAnd) ────────
app.use(telemetryLimiter, buildTelemetryRouter({ positionProcessor }));

// ── Tiles MBTiles ────────────────────────────────────────────────
app.use('/tiles', buildMapsRouter({ mapsDir: path.join(__dirname, '../', env.mapsDir) }));

// ── Autenticación ────────────────────────────────────────────────
app.use('/api/auth', authLimiter, buildAuthRouter({ userRepo }));

// ── API REST protegida (panel admin) ─────────────────────────────
app.use('/api/devices', authMiddleware, buildDevicesRouter({ deviceRepo }));
app.use('/api/geofences', authMiddleware, buildGeofencesRouter({ geofenceRepo, geofenceService, socketServer }));
app.use('/api/equipment', authMiddleware, buildEquipmentRouter({ equipmentRepo, equipmentManager, socketServer }));
app.use('/api/reports', authMiddleware, buildReportsRouter({ positionRepo }));
app.use('/api/users', authMiddleware, requireRole('admin'), buildUsersRouter({ userRepo }));

// Estado de flota / parada preventiva — usado también por UIs no autenticadas
// (operador/supervisor en campo, mismas reglas que antes de la migración)
app.use('/api/fleet', buildFleetRouter({ preventiveStopService, fleetState }));

// ── Health check ───────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const [pgOk, redisOk] = await Promise.all([db.checkConnection(), redis.checkConnection()]);
  res.json({
    status: pgOk && redisOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      postgres: pgOk ? 'connected' : 'disconnected',
      redis: redisOk ? 'connected' : 'disconnected',
      preventiveStop: preventiveStopService.getStatus()
    }
  });
});

/**
 * Hidrata en memoria las geocercas y equipo estático desde
 * PostgreSQL al arrancar, para que la evaluación en tiempo real
 * (GeofenceAlertService / StaticEquipmentManager) funcione desde
 * el primer segundo sin esperar a que se creen vía API.
 */
async function loadPersistedState() {
  try {
    const geofences = await geofenceRepo.findAllActive();
    geofences.forEach(g => geofenceService.addGeofence({
      id: g.id,
      name: g.name,
      type: g.type,
      center: { lat: g.center_lat, lon: g.center_lon },
      radiusMeters: g.radius_meters
    }));
    console.log(`✅ ${geofences.length} geocerca(s) cargada(s) desde PostgreSQL`);

    const equipment = await equipmentRepo.findAll();
    equipment.forEach(eq => equipmentManager.registerEquipment({
      id: eq.id,
      name: eq.name,
      type: eq.type,
      lat: eq.latitude,
      lon: eq.longitude,
      swingRadius: eq.swing_radius,
      safetyRadius: eq.safety_radius,
      status: eq.status
    }));
    console.log(`✅ ${equipment.length} equipo(s) estático(s) cargado(s) desde PostgreSQL`);
  } catch (err) {
    console.error('❌ Error cargando estado persistido:', err.message);
  }
}

// ── Servidor ───────────────────────────────────────────────────
const PORT = env.port;

loadPersistedState().finally(() => {
  signalLostService.startMonitoring();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Backend GAGA-GPS v2.0 (sistema propio) corriendo en puerto ${PORT}`);
    console.log(`   Telemetría: GET http://localhost:${PORT}/gps`);
    console.log(`   Operador:   http://localhost:${PORT}/operator`);
    console.log(`   Supervisor: http://localhost:${PORT}/supervisor`);
    console.log(`   Admin:      http://localhost:${PORT}/admin`);
    console.log(`   Health:     http://localhost:${PORT}/health`);
  });
});

module.exports = { app, server, io };
