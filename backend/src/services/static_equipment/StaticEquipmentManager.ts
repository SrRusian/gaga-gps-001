import type { EquipmentStatus } from '../../repositories/EquipmentRepository';

interface SocketIoLike {
  emit(event: string, payload: unknown): void;
}

export interface StaticEquipment {
  id: number;
  projectId: number | null;
  name: string;
  type: string;
  lat: number;
  lon: number;
  swingRadius: number;
  safetyRadius: number;
  status: EquipmentStatus;
  linkedDeviceId: string | null;
}

interface EvaluatedPosition {
  deviceId: string | number;
  latitude: number;
  longitude: number;
}

type ApproachState = 'clear' | 'outer' | 'inner' | 'minimum';

// global, no filtra por proyecto (gap de aislamiento conocido)
class StaticEquipmentManager {
  io: SocketIoLike;
  equipment: Record<number, StaticEquipment>;
  approachState: Record<string, ApproachState>;

  constructor({ io }: { io: SocketIoLike }) {
    this.io = io;
    this.equipment = {};
    this.approachState = {};
  }

  registerEquipment(eq: StaticEquipment): void {
    this.equipment[eq.id] = { ...eq };
    console.log(
      ` Equipo estático registrado: ${eq.name} | Radio giro: ${eq.swingRadius}m | Radio seguridad: ${eq.safetyRadius}m`,
    );
  }

  updateStatus(equipmentId: number, status: EquipmentStatus): void {
    if (this.equipment[equipmentId]) {
      this.equipment[equipmentId].status = status;
      console.log(` Equipo ${equipmentId} estado actualizado: ${status}`);
    }
  }

  clearDeviceLink(deviceId: string): StaticEquipment | null {
    const eq = Object.values(this.equipment).find((e) => e.linkedDeviceId === deviceId);
    if (!eq) return null;
    eq.linkedDeviceId = null;
    return eq;
  }

  clearEquipment(equipmentId: number): void {
    if (!this.equipment[equipmentId]) return;
    const suffix = `-${equipmentId}`;
    Object.keys(this.approachState).forEach((pairKey) => {
      if (!pairKey.endsWith(suffix)) return;
      const deviceId = pairKey.slice(0, -suffix.length);
      if (this.approachState[pairKey] !== 'clear') {
        this.io.emit('equipment:approach_clear', {
          deviceId,
          equipmentId,
          timestamp: new Date().toISOString(),
        });
      }
      delete this.approachState[pairKey];
    });
    delete this.equipment[equipmentId];
  }

  evaluate(position: EvaluatedPosition): void {
    const { deviceId, latitude, longitude } = position;

    Object.values(this.equipment).forEach((eq) => {
      if (eq.status === 'inactive') return;
      // evita que el equipo se alerte de si mismo via su propia tableta vinculada
      if (eq.linkedDeviceId != null && String(deviceId) === eq.linkedDeviceId) return;

      const distance = this.calculateDistance(latitude, longitude, eq.lat, eq.lon);

      const factor = eq.status === 'active_pause' ? 0.6 : 1.0;
      const outerZone = 50 * factor;
      const innerZone = eq.safetyRadius * 2 * factor;
      const minDistance = eq.safetyRadius * factor;

      const pairKey = `${deviceId}-${eq.id}`;
      const currentState: ApproachState = this.approachState[pairKey] || 'clear';

      if (distance <= minDistance) {
        if (currentState !== 'minimum') {
          this.triggerMinimumLimit(deviceId, eq, distance);
          this.approachState[pairKey] = 'minimum';
        }
      } else if (distance <= innerZone) {
        if (currentState !== 'inner' && currentState !== 'minimum') {
          this.triggerInnerZone(deviceId, eq, distance);
          this.approachState[pairKey] = 'inner';
        } else if (currentState === 'inner') {
          this.updateApproachDistance(deviceId, eq, distance);
        }
      } else if (distance <= outerZone) {
        if (currentState === 'clear') {
          this.triggerOuterZone(deviceId, eq, distance);
          this.approachState[pairKey] = 'outer';
        } else if (currentState === 'outer') {
          this.updateApproachDistance(deviceId, eq, distance);
        }
      } else {
        if (currentState !== 'clear') {
          this.clearApproach(deviceId, eq);
          this.approachState[pairKey] = 'clear';
        }
      }
    });
  }

  triggerOuterZone(deviceId: string | number, eq: StaticEquipment, distance: number): void {
    console.log(` ZONA EXTERIOR - Device ${deviceId} a ${Math.round(distance)}m de ${eq.name}`);

    this.io.emit('equipment:approach_outer', {
      deviceId,
      equipmentId: eq.id,
      equipmentName: eq.name,
      distance: Math.round(distance),
      message: `APROXIMACIÓN A ${eq.name.toUpperCase()} - REDUZCA VELOCIDAD Y ESPERE GUÍA`,
      timestamp: new Date().toISOString(),
    });
  }

  triggerInnerZone(deviceId: string | number, eq: StaticEquipment, distance: number): void {
    console.log(` ZONA INTERIOR - Device ${deviceId} a ${Math.round(distance)}m de ${eq.name}`);

    this.io.emit('equipment:approach_inner', {
      deviceId,
      equipmentId: eq.id,
      equipmentName: eq.name,
      distance: Math.round(distance),
      message: `ACÉRQUESE LENTAMENTE - DISTANCIA AL EQUIPO: ${Math.round(distance)}m`,
      timestamp: new Date().toISOString(),
    });

    this.io.emit('equipment:vehicle_approaching', {
      equipmentId: eq.id,
      deviceId,
      distance: Math.round(distance),
      timestamp: new Date().toISOString(),
    });
  }

  triggerMinimumLimit(deviceId: string | number, eq: StaticEquipment, distance: number): void {
    console.log(`LÍMITE MÍNIMO - Device ${deviceId} a ${Math.round(distance)}m de ${eq.name}`);

    this.io.emit('equipment:minimum_limit', {
      deviceId,
      equipmentId: eq.id,
      equipmentName: eq.name,
      distance: Math.round(distance),
      message: `DISTANCIA MÍNIMA ALCANZADA - DETENGA EL VEHÍCULO`,
      loop: true,
      timestamp: new Date().toISOString(),
    });
  }

  updateApproachDistance(deviceId: string | number, eq: StaticEquipment, distance: number): void {
    this.io.emit('equipment:distance_update', {
      deviceId,
      equipmentId: eq.id,
      distance: Math.round(distance),
      timestamp: new Date().toISOString(),
    });
  }

  clearApproach(deviceId: string | number, eq: StaticEquipment): void {
    console.log(`Device ${deviceId} salió de zona de ${eq.name}`);

    this.io.emit('equipment:approach_clear', {
      deviceId,
      equipmentId: eq.id,
      timestamp: new Date().toISOString(),
    });
  }

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

export default StaticEquipmentManager;
