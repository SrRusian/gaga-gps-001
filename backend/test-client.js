const http = require('http');
const { io } = require('socket.io-client');

const email = process.argv[2] || process.env.GAGA_TEST_EMAIL || 'admin@gaga.com';
const password = process.argv[3] || process.env.GAGA_TEST_PASSWORD || 'admin';

function login() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ email, password });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 3001,
        path: '/api/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`Login falló: ${data}`));
          resolve(JSON.parse(data).token);
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  let token;
  try {
    token = await login();
    console.log(`Login OK (${email})`);
  } catch (err) {
    console.error('No se pudo hacer login:', err.message);
    process.exit(1);
  }

  const socket = io('http://127.0.0.1:3001', {
    transports: ['websocket', 'polling'],
    reconnection: true,
    auth: { token },
  });

  socket.on('connect', () => {
    console.log('Cliente conectado al backend GAGA-GPS');
    console.log(`Socket ID: ${socket.id}`);
    console.log('Esperando posiciones de la flota...\n');
  });

  socket.on('connect_error', (err) => {
    console.error('Error de conexión:', err.message);
  });

  socket.on('fleet:update', (data) => {
    console.log(`[${data.timestamp}] Fleet update:`);
    data.positions.forEach((pos) => {
      console.log(
        `  Vehículo ${pos.deviceId} → Lat: ${pos.latitude} | Lon: ${pos.longitude} | Speed: ${pos.speed}`,
      );
    });
    console.log('');
  });

  socket.on('fleet:event', (data) => {
    console.log('Evento:', data.events);
  });

  socket.on('disconnect', () => {
    console.log('Desconectado del backend');
  });
})();
