require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const TraccarWsClient = require('./services/telemetry/TraccarWsClient');
const GeofenceAlertService = require('./services/alerts/GeofenceAlertService');
const SignalLostService = require('./services/alerts/SignalLostService');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

// Inicializar servicios
const geofenceService = new GeofenceAlertService({ io });
const signalLostService = new SignalLostService({ io });

// Geocercas de prueba — comentadas hasta necesitarlas
/*
geofenceService.addGeofence({
  id: 'test-warning-1',
  name: 'Zona Precaución Test',
  type: 'warning',
  center: { lat: 19.2539, lon: -103.7166 },
  radiusMeters: 50
});
geofenceService.addGeofence({
  id: 'test-danger-1',
  name: 'Zona Peligro Test',
  type: 'danger',
  center: { lat: 19.2539, lon: -103.7166 },
  radiusMeters: 20
});
*/

app.use(express.json());

// Servir UI del operador
app.use('/operator', express.static(
  path.join(__dirname, '../../ui-operator')
));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Iniciar cliente WebSocket de Traccar
const traccarClient = new TraccarWsClient({
  url: process.env.TRACCAR_WS_URL,
  email: process.env.TRACCAR_EMAIL,
  password: process.env.TRACCAR_PASSWORD,
  io,
  geofenceService,
  signalLostService
});

traccarClient.connect();

// Iniciar monitoreo de señal
signalLostService.startMonitoring();

// Cuando un cliente se conecta
io.on('connection', (socket) => {
  console.log(`✅ Cliente conectado: ${socket.id}`);

  // Enviar estado actual de la flota
  const currentFleet = traccarClient.getFleetState();
  if (Object.keys(currentFleet).length > 0) {
    socket.emit('fleet:update', {
      positions: Object.values(currentFleet),
      timestamp: new Date().toISOString()
    });
    console.log(`📡 Estado actual enviado: ${Object.keys(currentFleet).length} vehículos`);
  }

  // Enviar alertas activas de geocerca
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

  socket.on('disconnect', () => {
    console.log(`❌ Cliente desconectado: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend GAGA-GPS corriendo en puerto ${PORT}`);
});