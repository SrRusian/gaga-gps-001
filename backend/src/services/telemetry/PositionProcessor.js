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
 *   1. Filtrar saltos físicamente implausibles (PositionFilterService)
 *      — glitch RTK/NTRIP; si se rechaza, se persiste como inválida
 *      y el flujo termina ahí
 *   2. Persistir en PostgreSQL (PositionRepository)
 *   3. Actualizar estado en memoria/Redis (FleetStateManager)
 *   4. Ejecutar módulos de seguridad (sin modificar su lógica)
 *   5. Distribuir vía Socket.io (FleetSocketServer)
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
    equipmentManager,
    positionFilter
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

    // Descarta "teletransportes" por glitch RTK/NTRIP antes de que
    // el punto llegue a Redis/alertas/mapa — opcional, si no se
    // inyecta el comportamiento es idéntico al de antes.
    this.positionFilter = positionFilter;
  }

  /**
   * Procesa una posición normalizada proveniente del endpoint /gps
   * @param {Object} position - { deviceId, latitude, longitude, altitude,
   *   speed, course, accuracy, battery, fixTime }
   */
  async process(position) {
    try {
      // 1. Auto-registrar dispositivo y marcarlo online — corre
      // siempre, incluso si el fix resulta descartado más abajo:
      // el dispositivo sigue comunicándose, solo el dato de
      // posición es el que no es confiable.
      if (this.deviceManager) {
        const device = await this.deviceManager.ensureRegistered(position.deviceId);
        await this.deviceManager.markOnline(position.deviceId, position.fixTime);

        // Se enriquece la posición con nombre/tipo del dispositivo
        // (p. ej. "Tableta", "Excavadora") para que Operador/Supervisor
        // muestren una etiqueta correcta sin tener que consultar la
        // API protegida de dispositivos — positionRepo.save() ignora
        // estos campos extra al insertar (solo lee los suyos).
        if (device) {
          position.deviceName = device.name;
          position.deviceType = device.type;
        }
      }

      if (this.signalLostService) {
        this.signalLostService.recordPosition(position.deviceId);
      }

      // 1.5 Filtro anti-teletransporte (glitch RTK/NTRIP) — compara
      // contra la última posición ACEPTADA del dispositivo. Si el
      // salto es físicamente implausible, se persiste marcado como
      // inválido (auditable) pero no toca Redis/alertas/mapa.
      if (this.positionFilter) {
        const verdict = this.positionFilter.evaluate(position);

        if (!verdict.accepted) {
          position.valid = false;
          position.attributes = {
            ...(position.attributes || {}),
            rejectReason: verdict.reason,
            impliedSpeedKmh: verdict.impliedSpeedKmh,
            allowedMaxKmh: verdict.allowedMaxKmh,
            distanceMeters: verdict.distanceMeters
          };

          await this.positionRepo.save(position);

          console.warn(`⚠️  Posición descartada (${verdict.reason}) — Device: ${position.deviceId} | salto: ${verdict.distanceMeters?.toFixed(1)}m | vel. implícita: ${verdict.impliedSpeedKmh?.toFixed(1)}km/h (máx. permitido ${verdict.allowedMaxKmh?.toFixed(1)}km/h)`);

          return position;
        }

        if (verdict.resynced) {
          console.warn(`⚠️  Device ${position.deviceId} resincronizado tras varios saltos consecutivos — vel. implícita ${verdict.impliedSpeedKmh?.toFixed(1)}km/h`);
        }
      }

      // 2. Persistir en PostgreSQL/TimescaleDB
      await this.positionRepo.save(position);

      // 3. Actualizar estado en memoria (Redis)
      await this.fleetState.update(position);

      // 4. Ejecutar módulos de seguridad — NO se modifican, solo se invocan
      if (this.geofenceService) {
        this.geofenceService.evaluate(position);
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
