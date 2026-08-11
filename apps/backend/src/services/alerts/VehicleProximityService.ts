/**
 * VehicleProximityService.ts
 *
 * Responsabilidad: radar de proximidad por distancia entre vehículos
 * que están FUERA de cualquier corredor/ruta autorizada (geocerca
 * tipo polyline) — patios, zonas de maniobra y áreas abiertas sin
 * ruta definida.
 *
 * A diferencia de CollisionRiskService (RF-ALR-10, todos-contra-todos
 * con heurística de trayectorias convergentes), este servicio es
 * puro por distancia — no exige convergencia, porque en zonas sin
 * ruta definida esa heurística es poco confiable. Es un servicio
 * nuevo y separado deliberadamente: CollisionRiskService tiene un
 * bug conocido y documentado (dedupe de pares vía Math.min sobre
 * deviceId string, que da NaN) que no se toca — este servicio nace
 * con una clave de par correcta desde el día uno.
 *
 * RF asociados: extensión de seguridad — sin RF-ALR asignado aún.
 */
import type { Geofence } from '@gaga-gps/shared-types';
import { isInsideGeofence } from '../../utils/geometry';

interface SocketIoLike {
  emit(event: string, payload: unknown): void;
}

interface EvaluatedPosition {
  deviceId: string;
  latitude: number;
  longitude: number;
}

type ProximityAlertLevel = 'none' | 'warning' | 'critical';

class VehicleProximityService {
  io: SocketIoLike;
  proximityAlerts: Record<string, ProximityAlertLevel>;
  readonly VISIBILITY_METERS = 150;
  readonly WARNING_METERS = 80;
  readonly CRITICAL_METERS = 35;

  constructor({ io }: { io: SocketIoLike }) {
    this.io = io;
    // Estado de alerta por par de vehículos — clave: ids ordenados
    // alfabéticamente como string, nunca Math.min/Math.max numérico
    // (deviceId es un string, p. ej. "CAMION-01").
    this.proximityAlerts = {};
  }

  /**
   * Evalúa la posición de un vehículo contra el resto de la flota
   * activa, mostrando distancia en vivo al más cercano y alertando
   * solo cuando ninguno de los dos está dentro de un corredor
   * autorizado.
   */
  evaluate(
    position: EvaluatedPosition,
    fleetState: Record<string, EvaluatedPosition>,
    activeGeofences: Geofence[] = [],
  ): void {
    const { deviceId } = position;
    if (this.isInsideAnyRoute(position, activeGeofences)) {
      // Dentro de una ruta autorizada — este radar no aplica aquí,
      // el carril ya acota la separación entre vehículos.
      return;
    }

    let nearest: { deviceId: string; distance: number } | null = null;

    Object.values(fleetState).forEach((otherPos) => {
      if (otherPos.deviceId === deviceId) return;
      if (this.isInsideAnyRoute(otherPos, activeGeofences)) return;

      const distance = this.calculateDistance(
        position.latitude,
        position.longitude,
        otherPos.latitude,
        otherPos.longitude,
      );

      if (!nearest || distance < nearest.distance) {
        nearest = { deviceId: otherPos.deviceId, distance };
      }

      this.evaluatePair(deviceId, otherPos.deviceId, distance);
    });

    if (nearest !== null) {
      const { deviceId: nearestDeviceId, distance } = nearest as { deviceId: string; distance: number };
      if (distance <= this.VISIBILITY_METERS) {
        this.io.emit('proximity:distance_update', {
          deviceId,
          nearestDeviceId,
          distance: Math.round(distance),
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  /** true si la posición está dentro del ancho de algún corredor (polyline) activo. */
  isInsideAnyRoute(position: EvaluatedPosition, activeGeofences: Geofence[]): boolean {
    return activeGeofences.some(
      (g) =>
        g.shapeType === 'polyline' &&
        isInsideGeofence(position.latitude, position.longitude, g),
    );
  }

  evaluatePair(deviceId1: string, deviceId2: string, distance: number): void {
    const pairKey = [deviceId1, deviceId2].sort().join('-');
    const currentAlert = this.proximityAlerts[pairKey] || 'none';

    if (distance <= this.CRITICAL_METERS) {
      if (currentAlert !== 'critical') {
        this.triggerCritical(deviceId1, deviceId2, distance);
        this.proximityAlerts[pairKey] = 'critical';
      }
    } else if (distance <= this.WARNING_METERS) {
      if (currentAlert === 'none') {
        this.triggerWarning(deviceId1, deviceId2, distance);
        this.proximityAlerts[pairKey] = 'warning';
      }
    } else if (currentAlert !== 'none') {
      this.clearAlert(deviceId1, deviceId2);
      this.proximityAlerts[pairKey] = 'none';
    }
  }

  triggerWarning(deviceId1: string, deviceId2: string, distance: number): void {
    console.log(
      `⚠️  PROXIMIDAD FUERA DE RUTA — Vehículos ${deviceId1} y ${deviceId2} a ${Math.round(distance)}m`,
    );

    const payload = {
      type: 'proximity_warning',
      deviceId1,
      deviceId2,
      distance: Math.round(distance),
      message: `PRECAUCIÓN — VEHÍCULO A ${Math.round(distance)} METROS — FUERA DE RUTA`,
      timestamp: new Date().toISOString(),
    };

    this.io.emit('proximity:warning', payload);
    this.io.emit('supervisor:proximity', { ...payload, level: 1 });
  }

  triggerCritical(deviceId1: string, deviceId2: string, distance: number): void {
    console.log(
      `🚨 PROXIMIDAD CRÍTICA FUERA DE RUTA — Vehículos ${deviceId1} y ${deviceId2} a ${Math.round(distance)}m`,
    );

    const payload = {
      type: 'proximity_critical',
      deviceId1,
      deviceId2,
      distance: Math.round(distance),
      message: 'PELIGRO — VEHÍCULO MUY CERCA FUERA DE RUTA — REDUZCA VELOCIDAD',
      loop: true,
      timestamp: new Date().toISOString(),
    };

    this.io.emit('proximity:critical', payload);
    this.io.emit('supervisor:proximity', { ...payload, level: 2 });
  }

  clearAlert(deviceId1: string, deviceId2: string): void {
    console.log(`✅ Vehículos ${deviceId1} y ${deviceId2} ya no están en riesgo de proximidad`);

    const timestamp = new Date().toISOString();
    this.io.emit('proximity:clear', { deviceId1, deviceId2, timestamp });
    this.io.emit('supervisor:proximity', { deviceId1, deviceId2, level: 0, timestamp });
  }

  /** Haversine — distancia en metros. Misma fórmula usada en el resto del sistema. */
  calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  toRad(deg: number): number {
    return deg * (Math.PI / 180);
  }
}

export default VehicleProximityService;
