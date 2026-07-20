const { io } = require('socket.io-client');

const socket = io('http://127.0.0.1:3001', {
  transports: ['websocket', 'polling'],
  reconnection: true
});

socket.on('connect', () => {
  console.log('✅ Cliente conectado al backend GAGA-GPS');
  console.log(`Socket ID: ${socket.id}`);
  console.log('Esperando posiciones de la flota...\n');
});

socket.on('connect_error', (err) => {
  console.error('❌ Error de conexión:', err.message);
});

socket.on('fleet:update', (data) => {
  console.log(`[${data.timestamp}] Fleet update:`);
  data.positions.forEach(pos => {
    console.log(`  Vehículo ${pos.deviceId} → Lat: ${pos.latitude} | Lon: ${pos.longitude} | Speed: ${pos.speed}`);
  });
  console.log('');
});

socket.on('fleet:event', (data) => {
  console.log('Evento:', data.events);
});

socket.on('disconnect', () => {
  console.log('Desconectado del backend');
});