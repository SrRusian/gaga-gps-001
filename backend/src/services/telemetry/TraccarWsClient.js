/**
 * TraccarWsClient.js
 *
 * Responsabilidad: Conectarse al WebSocket de Traccar
 * y distribuir posiciones en tiempo real via Socket.io
 * a todos los clientes conectados.
 *
 * Consume: WebSocket de Traccar /api/socket
 * Produce: Evento 'fleet:update' via Socket.io
 *
 * RF asociados: RF-TEL-01, RF-TEL-02
 */

const WebSocket = require('ws');
const https = require('https');

class TraccarWsClient {
  constructor({ url, email, password, io, geofenceService }) {
    this.url = url;
    this.email = email;
    this.password = password;
    this.io = io;
    this.geofenceService = geofenceService;
    this.ws = null;
    this.sessionCookie = null;
    this.reconnectDelay = 5000;
    this.fleetState = {};
  }

  // Paso 1: Login en Traccar para obtener cookie de sesión
  async login() {
    return new Promise((resolve, reject) => {

      const body = `email=${encodeURIComponent(this.email)}&password=${encodeURIComponent(this.password)}`;

      const traccarUrl = new URL(this.url.replace('ws://', 'http://').replace('wss://', 'https://'));

      const options = {
        hostname: traccarUrl.hostname,
        port: traccarUrl.port || 8082,
        path: '/api/session',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const req = require('http').request(options, (res) => {
        const cookies = res.headers['set-cookie'];
        if (cookies) {
          this.sessionCookie = cookies.map(c => c.split(';')[0]).join('; ');
          console.log('Traccar login exitoso');
          resolve(this.sessionCookie);
        } else {
          reject(new Error('No se recibió cookie de sesión'));
        }
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // Paso 2: Conectar al WebSocket con la cookie
  async connect() {
    try {
      await this.login();

      const wsUrl = `${this.url}/api/socket`;
      console.log(`Conectando a Traccar WebSocket: ${wsUrl}`);

      this.ws = new WebSocket(wsUrl, {
        headers: { Cookie: this.sessionCookie }
      });

      this.ws.on('open', () => {
        console.log('WebSocket de Traccar conectado');
      });

      this.ws.on('message', (data) => {
        this.handleMessage(JSON.parse(data));
      });

      this.ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
      });

      this.ws.on('close', () => {
        console.warn(`WebSocket cerrado — reconectando en ${this.reconnectDelay / 1000}s`);
        setTimeout(() => this.connect(), this.reconnectDelay);
      });

    } catch (err) {
      console.error('Error conectando a Traccar:', err.message);
      setTimeout(() => this.connect(), this.reconnectDelay);
    }
  }

  // Paso 3: Procesar mensajes del WebSocket
  handleMessage(payload) {
    if (payload.positions && payload.positions.length > 0) {
      payload.positions.forEach(pos => {
        // Guardar en estado en memoria
        this.fleetState[pos.deviceId] = pos;

        console.log(`Posición recibida — Device: ${pos.deviceId} | Lat: ${pos.latitude} | Lon: ${pos.longitude} | Speed: ${pos.speed} km/h`);
      
        if (this.geofenceService) {
          this.geofenceService.evaluate(pos);
        }
      });

      this.io.emit('fleet:update', {
        positions: payload.positions,
        timestamp: new Date().toISOString()
      });
    }

    if (payload.events && payload.events.length > 0) {
      payload.events.forEach(event => {
        console.log(`Evento — Type: ${event.type} | Device: ${event.deviceId}`);
      });

      this.io.emit('fleet:event', {
        events: payload.events,
        timestamp: new Date().toISOString()
      });
    }
  }

  // Retorna el estado actual de toda la flota en memoria
  getFleetState() {
    return this.fleetState;
  }
}

module.exports = TraccarWsClient;