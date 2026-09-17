export interface PreventiveStopStatus {
  isActive: boolean;
  activatedAt: string | null;
  activatedBy: 'auto' | 'supervisor' | null;
  reason: string | null;
}

export interface GeofenceAlertPayload {
  type:
    | 'geofence_red'
    | 'geofence_yellow'
    | 'geofence_parking'
    | 'geofence_forbidden'
    | 'geofence_maintenance'
    | 'geofence_left_allowed';
  deviceId: string;
  geofenceId: number;
  geofenceName: string;
  message: string;
  loop: boolean;
  timestamp: string;
}

export interface SpeedAlertPayload {
  type: 'speed_warning' | 'speed_danger';
  deviceId: string;
  speedKmh: number;
  limitKmh: number;
  message: string;
  loop: boolean;
  timestamp: string;
}

export interface GeofenceClearPayload {
  deviceId: string;
  timestamp: string;
}

// aviso silencioso de proximidad a una geocerca peligrosa (rectangulo real del vehiculo, ver
// GeofenceAlertService "tier silencioso") - canal propio, deliberadamente separado de
// GeofenceAlertPayload/GeofenceClearPayload: se manda SOLO al operador afectado (sendToDevice,
// nunca broadcastToProject), nunca se persiste (ni alert_events ni infractions), y no debe poder
// pisar/limpiar una alerta real que ya este en pantalla (ver alert:critical/alert:warning/alert:clear)
export interface GeofenceProximityNoticePayload {
  deviceId: string;
  geofenceId: number;
  geofenceName: string;
  distanceMeters: number;
  message: string;
  timestamp: string;
}

export interface GeofenceProximityClearPayload {
  deviceId: string;
  timestamp: string;
}

export interface SupervisorGeofenceAlertPayload extends Partial<GeofenceAlertPayload> {
  deviceId: string;
  action: 'entered' | 'exited';
  timestamp: string;
}

export interface SignalLostPayload {
  deviceId: string;
  elapsedSeconds: number;
  message: string;
  timestamp: string;
  loop?: boolean;
}

export interface SignalRecoveredPayload {
  deviceId: string;
  message: string;
  timestamp: string;
}

export interface SupervisorSignalLostPayload {
  deviceId: string;
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

export type IncidentCategory = 'obstacle' | 'accident' | 'traffic' | 'other';

export interface IncidentReportedPayload {
  id: number;
  deviceId: string;
  category: IncidentCategory;
  message: string | null;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  reportedAt: string;
}

export interface IncidentResolvedPayload {
  id: number;
}

export interface IncidentNearbyPayload {
  deviceId: string;
  incidentId: number;
  category: IncidentCategory;
  distance: number;
  message: string;
}

export interface SupervisorIncidentPayload extends Partial<IncidentReportedPayload> {
  id: number;
  level: 0 | 1;
}

export type AlertEventType =
  | 'geofence'
  | 'signal_lost'
  | 'collision'
  | 'proximity'
  | 'preventive_stop'
  | 'incident'
  | 'equipment_variable'
  | 'speed'
  | 'power_loss';

export type AlertEventSeverity = 'info' | 'warning' | 'danger';

export interface AlertEventEntry {
  key: string;
  message: string;
  severity: AlertEventSeverity;
  triggeredAt: string;
}

export interface AlertHistoryRow {
  id: number;
  project_id: number | null;
  alert_type: AlertEventType;
  severity: AlertEventSeverity;
  device_id: string | null;
  device_id_2: string | null;
  message: string | null;
  metadata: Record<string, unknown> | null;
  triggered_at: string;
  resolved_at: string | null;
}

// registro permanente de infracciones reales (velocidad/geocerca) - ver backend/db/001_init.sql
// tabla `infractions`, generado solo por el sistema (nunca creado a mano)
export type InfractionType = 'speed' | 'geofence';

export interface InfractionRow {
  id: number;
  project_id: number | null;
  device_id: string;
  device_name: string | null;
  operator_session_id: number | null;
  operator_name: string | null;
  infraction_type: InfractionType;
  message: string;
  latitude: number;
  longitude: number;
  metadata: Record<string, unknown> | null;
  occurred_at: string;
  reviewed_by: number | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
}
