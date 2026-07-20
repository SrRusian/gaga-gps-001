/**
 * app.js
 * Entry point del backend GAGA-GPS
 * Conecta Traccar via WebSocket y distribuye
 * posiciones a todos los clientes via Socket.io
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const TraccarWsClient = require('./services/telemetry/TraccarWsClient');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Cuando un cliente (tableta/supervisor) se conecta
io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);

  socket.on('disconnect', () => {
    console.log(`Cliente desconectado: ${socket.id}`);
  });
});

// Iniciar cliente WebSocket de Traccar
const traccarClient = new TraccarWsClient({
  url: process.env.TRACCAR_WS_URL,
  email: process.env.TRACCAR_EMAIL,
  password: process.env.TRACCAR_PASSWORD,
  io // pasamos Socket.io para distribuir posiciones
});

traccarClient.connect();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Backend GAGA-GPS corriendo en puerto ${PORT}`);
});