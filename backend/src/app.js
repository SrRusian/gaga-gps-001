require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const TraccarWsClient = require('./services/telemetry/TraccarWsClient');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

app.use(express.json());
const path = require('path');

// Servir UI del operador
app.use('/operator', express.static(
  path.join(__dirname, '../../ui-operator')
));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Cuando un cliente se conecta
io.on('connection', (socket) => {
  console.log(`✅ Cliente conectado: ${socket.id}`);

  // Enviar estado actual de la flota al cliente que se acaba de conectar
  const currentFleet = traccarClient.getFleetState();
  if (Object.keys(currentFleet).length > 0) {
    socket.emit('fleet:update', {
      positions: Object.values(currentFleet),
      timestamp: new Date().toISOString()
    });
    console.log(`📡 Estado actual enviado a nuevo cliente: ${Object.keys(currentFleet).length} vehículos`);
  }

  socket.on('disconnect', () => {
    console.log(`❌ Cliente desconectado: ${socket.id}`);
  });
});

// Iniciar cliente WebSocket de Traccar
const traccarClient = new TraccarWsClient({
  url: process.env.TRACCAR_WS_URL,
  email: process.env.TRACCAR_EMAIL,
  password: process.env.TRACCAR_PASSWORD,
  io
});

traccarClient.connect();

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend GAGA-GPS corriendo en puerto ${PORT}`);
});