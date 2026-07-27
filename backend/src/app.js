require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

const TraccarWsClient = require('./services/telemetry/TraccarWsClient');
const GeofenceAlertService = require('./services/alerts/GeofenceAlertService');
const SignalLostService = require('./services/alerts/SignalLostService');
const CollisionRiskService = require('./services/alerts/CollisionRiskService');
const StaticEquipmentManager = require('./services/static_equipment/StaticEquipmentManager');
const PreventiveStopService = require('./services/alerts/PreventiveStopService');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

app.use(express.json());

// ── Servicios de seguridad ─────────────────────────────────────
const geofenceService      = new GeofenceAlertService({ io });
const preventiveStopService = new PreventiveStopService({ io });
const signalLostService    = new SignalLostService({ io, preventiveStopService });
const collisionService     = new CollisionRiskService({ io });
const equipmentManager     = new StaticEquipmentManager({ io });

// ── UI estáticas ───────────────────────────────────────────────
app.use('/operator',   express.static(path.join(__dirname, '../ui-operator')));
app.use('/supervisor', express.static(path.join(__dirname, '../ui-supervisor')));

// ── Tiles MBTiles ──────────────────────────────────────────────
let tilesDb = null;

function getTilesDb() {
  if (tilesDb) return tilesDb;
  const dbPath = path.join(__dirname, '../maps/alcaraces.mbtiles');
  tilesDb = new Database(dbPath, { readonly: true });
  console.log('✅ MBTiles cargado');
  return tilesDb;
}

app.get('/tiles/alcaraces/:z/:x/:y.png', (req, res) => {
  const zoom  = parseInt(req.params.z);
  const tileX = parseInt(req.params.x);
  const tileY = (2 ** zoom - 1) - parseInt(req.params.y);

  try {
    const db  = getTilesDb();
    const row = db.prepare(
      'SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?'
    ).get(zoom, tileX, tileY);

    if (row) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(Buffer.from(row.tile_data));
    } else {
      res.status(204).send();
    }
  } catch (err) {
    console.error('Error tile:', err.message);
    res.status(500).send('Error');
  }
});

// ── API REST ───────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      traccar: traccarClient?.ws?.readyState === 1 ? 'connected' : 'disconnected',
      preventiveStop: preventiveStopService.getStatus()
    }
  });
});

// Geocercas
app.get('/api/geofences', (req, res) => {
  res.json(geofenceService.activeGeofences);
});

app.post('/api/geofences', (req, res) => {
  const { id, name, type, center, radiusMeters } = req.body;
  if (!id || !name || !type || !center || !radiusMeters) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }
  geofenceService.addGeofence({ id, name, type, center, radiusMeters });
  // Notificar a todos los dispositivos
  io.emit('geofences:update', geofenceService.activeGeofences);
  res.json({ success: true, geofence: { id, name, type, center, radiusMeters } });
});

app.delete('/api/geofences/:id', (req, res) => {
  geofenceService.removeGeofence(req.params.id);
  io.emit('geofences:update', geofenceService.activeGeofences);
  res.json({ success: true });
});

// Equipos estáticos
app.get('/api/equipment', (req, res) => {
  res.json(Object.values(equipmentManager.equipment));
});

app.post('/api/equipment', (req, res) => {
  const eq = req.body;
  if (!eq.id || !eq.name || !eq.lat || !eq.lon) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }
  equipmentManager.registerEquipment(eq);
  res.json({ success: true });
});

app.patch('/api/equipment/:id/status', (req, res) => {
  const { status } = req.body;
  equipmentManager.updateStatus(req.params.id, status);
  res.json({ success: true });
});

// Parada preventiva
app.post('/api/fleet/stop', (req, res) => {
  const { reason } = req.body;
  preventiveStopService.activate(
    reason || 'Activado manualmente por supervisor',
    'supervisor'
  );
  res.json({ success: true, status: preventiveStopService.getStatus() });
});

app.post('/api/fleet/resume', (req, res) => {
  preventiveStopService.deactivate('supervisor');
  res.json({ success: true, status: preventiveStopService.getStatus() });
});

app.get('/api/fleet/stop/status', (req, res) => {
  res.json(preventiveStopService.getStatus());
});

// ── Socket.io ──────────────────────────────────────────────────
const traccarClient = new TraccarWsClient({
  url:              process.env.TRACCAR_WS_URL,
  email:            process.env.TRACCAR_EMAIL,
  password:         process.env.TRACCAR_PASSWORD,
  io,
  geofenceService,
  signalLostService,
  collisionService,
  equipmentManager
});

traccarClient.connect();
signalLostService.startMonitoring();

io.on('connection', (socket) => {
  console.log(`✅ Cliente conectado: ${socket.id}`);

  // Enviar estado actual de la flota
  const currentFleet = traccarClient.getFleetState();
  if (Object.keys(currentFleet).length > 0) {
    socket.emit('fleet:update', {
      positions: Object.values(currentFleet),
      timestamp: new Date().toISOString()
    });
  }

  // Enviar geocercas activas
  socket.emit('geofences:update', geofenceService.activeGeofences);

  // Enviar alertas activas
  const activeAlerts = geofenceService.getActiveAlerts();
  Object.entries(activeAlerts).forEach(([deviceId, severity]) => {
    if (severity === 'danger') {
      socket.emit('alert:critical', {
        type: 'geofence_red',
        deviceId: parseInt(deviceId),
        message: 'PELIGRO — DETENER VEHÍCULO INMEDIATAMENTE',
        loop: true,
        timestamp: new Date().toISOString()
      });
    } else if (severity === 'warning') {
      socket.emit('alert:warning', {
        type: 'geofence_yellow',
        deviceId: parseInt(deviceId),
        message: 'PRECAUCIÓN — ZONA DE RIESGO — REDUCIR VELOCIDAD',
        timestamp: new Date().toISOString()
      });
    }
  });

  // Enviar estado de parada preventiva
  const stopStatus = preventiveStopService.getStatus();
  if (stopStatus.isActive) {
    socket.emit('fleet:preventive_stop', {
      active: true,
      reason: stopStatus.reason,
      message: 'ALTO TOTAL — DETENGA EL VEHÍCULO INMEDIATAMENTE Y REPORTE A CENTRAL POR RADIO',
      loop: true,
      timestamp: new Date().toISOString()
    });
  }

  socket.on('disconnect', () => {
    console.log(`❌ Cliente desconectado: ${socket.id}`);
  });
});

// ── Servidor ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend GAGA-GPS v1.0 corriendo en puerto ${PORT}`);
  console.log(`   Operador:   http://localhost:${PORT}/operator`);
  console.log(`   Supervisor: http://localhost:${PORT}/supervisor`);
  console.log(`   Health:     http://localhost:${PORT}/health`);
});