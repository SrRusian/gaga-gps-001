/**
 * Payloads de los eventos de alerta emitidos por los módulos de
 * seguridad (RF-ALR) vía Socket.io. Formas tomadas directamente del
 * código real de cada servicio (no especulativas) — ver
 * apps/backend/src/services/alerts/*.ts.
 */

/**
 * Respuesta de GET /api/fleet/stop/status y del campo `status` de
 * POST /api/fleet/stop|resume — ver
 * apps/backend/src/services/alerts/PreventiveStopService.ts (getStatus).
 */
export interface PreventiveStopStatus {
  isActive: boolean;
  activatedAt: string | null;
  activatedBy: 'auto' | 'supervisor' | null;
  reason: string | null;
}

export interface GeofenceAlertPayload {
  type: 'geofence_red' | 'geofence_yellow' | 'geofence_parking';
  deviceId: string;
  geofenceId: number;
  geofenceName: string;
  message: string;
  loop: boolean;
  timestamp: string;
}

export interface GeofenceClearPayload {
  deviceId: string;
  timestamp: string;
}

export interface SupervisorGeofenceAlertPayload extends Partial<GeofenceAlertPayload> {
  deviceId: string;
  action: 'entered' | 'exited';
  timestamp: string;
}

export interface SignalLostPayload {
  deviceId: number;
  elapsedSeconds: number;
  message: string;
  timestamp: string;
  loop?: boolean;
}

export interface SignalRecoveredPayload {
  deviceId: number;
  message: string;
  timestamp: string;
}

export interface SupervisorSignalLostPayload {
  deviceId: number;
  level: 0 | 1 | 2;
  elapsedSeconds?: number;
  message?: string;
  timestamp: string;
}

export interface CollisionPayload {
  type: 'collision_proximity' | 'collision_critical';
  deviceId1: number;
  deviceId2: number;
  distance: number;
  message: string;
  loop?: boolean;
  timestamp: string;
}

export interface CollisionClearPayload {
  deviceId1: number;
  deviceId2: number;
  timestamp: string;
}

export interface SupervisorCollisionPayload extends Partial<CollisionPayload> {
  deviceId1: number;
  deviceId2: number;
  level: 0 | 1 | 2;
  timestamp: string;
}

/**
 * Radar de proximidad fuera de ruta — VehicleProximityService.
 * Distinto de CollisionPayload (RF-ALR-10, con heurística de
 * convergencia): este es puro por distancia, solo para vehículos
 * que no están dentro de ningún corredor (polyline) activo.
 */
export interface ProximityPayload {
  type: 'proximity_warning' | 'proximity_critical';
  deviceId1: string;
  deviceId2: string;
  distance: number;
  message: string;
  loop?: boolean;
  timestamp: string;
}

export interface ProximityClearPayload {
  deviceId1: string;
  deviceId2: string;
  timestamp: string;
}

export interface ProximityDistanceUpdatePayload {
  deviceId: string;
  nearestDeviceId: string;
  distance: number;
  timestamp: string;
}

export interface SupervisorProximityPayload extends Partial<ProximityPayload> {
  deviceId1: string;
  deviceId2: string;
  level: 0 | 1 | 2;
  timestamp: string;
}

export interface PreventiveStopActivePayload {
  active: true;
  reason: string;
  triggeredBy: 'auto' | 'supervisor';
  message: string;
  loop: true;
  activatedAt: string;
  timestamp: string;
}

export interface PreventiveStopClearPayload {
  active: false;
  deactivatedBy: string;
  message: string;
  timestamp: string;
}

export interface SupervisorPreventiveStopPayload {
  active: boolean;
  reason?: string;
  triggeredBy?: 'auto' | 'supervisor';
  deactivatedBy?: string;
  activatedAt?: string | null;
  timestamp: string;
}

export interface EquipmentApproachPayload {
  deviceId: string | number;
  equipmentId: number;
  equipmentName: string;
  distance: number;
  message: string;
  timestamp: string;
  loop?: boolean;
}

export interface EquipmentDistanceUpdatePayload {
  deviceId: string | number;
  equipmentId: number;
  distance: number;
  timestamp: string;
}

export interface EquipmentApproachClearPayload {
  deviceId: string | number;
  equipmentId: number;
  timestamp: string;
}

export interface EquipmentVehicleApproachingPayload {
  equipmentId: number;
  deviceId: string | number;
  distance: number;
  timestamp: string;
}

export interface EquipmentStatusUpdatePayload {
  equipmentId: number;
  status: string;
  timestamp: string;
}
