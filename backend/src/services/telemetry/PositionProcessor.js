/**
 * PositionProcessor.js
 *
 * Responsabilidad: Procesar una posición entrante del receptor
 * OsmAnd (GET /gps) — reemplaza a TraccarWsClient.js.
 *
 * En lugar de recibir posiciones vía WebSocket de Traccar, este
 * servicio se invoca directamente desde telemetry.routes.js
 * cada vez que una tableta reporta su posición.
 *
 * Flujo:
 *   1. Persistir en PostgreSQL (PositionRepository)
 *   2. Actualizar estado en memoria/Redis (FleetStateManager)
 *   3. Ejecutar módulos de seguridad (sin modificar su lógica)
 *   4. Distribuir vía Socket.io (FleetSocketServer)
 *
 * RF asociados: RF-TEL-01, RF-TEL-02
 */

class PositionProcessor {

  constructor({
    positionRepo,
    fleetState,
    socketServer,
    deviceManager,
    geofenceService,
    signalLostService,
    collisionService,
    equipmentManager
  }) {
    this.positionRepo = positionRepo;
    this.fleetState = fleetState;
    this.socketServer = socketServer;
    this.deviceManager = deviceManager;

    // Servicios de seguridad — los mismos usados antes por TraccarWsClient
    this.geofenceService = geofenceService;
    this.signalLostService = signalLostService;
    this.collisionService = collisionService;
    this.equipmentManager = equipmentManager;
  }

  /**
   * Procesa una posición normalizada proveniente del endpoint /gps
   * @param {Object} position - { deviceId, latitude, longitude, altitude,
   *   speed, course, accuracy, battery, fixTime }
   */
  async process(position) {
    try {
      // 1. Auto-registrar dispositivo y marcarlo online
      if (this.deviceManager) {
        await this.deviceManager.ensureRegistered(position.deviceId);
        await this.deviceManager.markOnline(position.deviceId, position.fixTime);
      }

      // 2. Persistir en PostgreSQL/TimescaleDB
      await this.positionRepo.save(position);

      // 3. Actualizar estado en memoria (Redis)
      await this.fleetState.update(position);

      // 4. Ejecutar módulos de seguridad — NO se modifican, solo se invocan
      if (this.geofenceService) {
        this.geofenceService.evaluate(position);
      }

      if (this.signalLostService) {
        this.signalLostService.recordPosition(position.deviceId);
      }

      if (this.collisionService) {
        const fleet = await this.fleetState.getAll();
        this.collisionService.evaluate(position, fleet);
      }

      if (this.equipmentManager) {
        this.equipmentManager.evaluate(position);
      }

      // 5. Distribuir a clientes conectados (operador/supervisor)
      this.socketServer.broadcast('fleet:update', {
        positions: [position],
        timestamp: new Date().toISOString()
      });

      console.log(`📍 Posición procesada — Device: ${position.deviceId} | Lat: ${position.latitude} | Lon: ${position.longitude}`);

      return position;
    } catch (err) {
      console.error('❌ PositionProcessor.process:', err.message);
      throw err;
    }
  }
}

module.exports = PositionProcessor;
