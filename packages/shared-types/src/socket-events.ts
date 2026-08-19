import type {
  AlertEventEntry,
  CollisionClearPayload,
  CollisionPayload,
  EquipmentApproachClearPayload,
  EquipmentApproachPayload,
  EquipmentDistanceUpdatePayload,
  EquipmentStatusUpdatePayload,
  EquipmentVehicleApproachingPayload,
  GeofenceAlertPayload,
  GeofenceClearPayload,
  IncidentNearbyPayload,
  IncidentReportedPayload,
  IncidentResolvedPayload,
  PreventiveStopActivePayload,
  PreventiveStopClearPayload,
  ProximityClearPayload,
  ProximityDistanceUpdatePayload,
  ProximityPayload,
  SignalLostPayload,
  SignalRecoveredPayload,
  SupervisorCollisionPayload,
  SupervisorGeofenceAlertPayload,
  SupervisorIncidentPayload,
  SupervisorPreventiveStopPayload,
  SupervisorProximityPayload,
  SupervisorSignalLostPayload,
} from './alerts';
import type { StaticEquipment } from './equipment';
import type { Geofence } from './geofence';
import type { ActiveMap } from './maps';
import type { Position } from './position';

export interface FleetUpdatePayload {
  positions: Position[];
  timestamp: string;
}

export interface MapsActiveUpdatePayload {
  maps: ActiveMap[];
}

export interface ServerToClientEvents {
  'fleet:update': (payload: FleetUpdatePayload) => void;
  'geofences:update': (geofences: Geofence[]) => void;
  'equipment:update': (equipment: StaticEquipment[]) => void;
  'maps:active_update': (payload: MapsActiveUpdatePayload) => void;

  'alert:critical': (payload: GeofenceAlertPayload) => void;
  'alert:warning': (payload: GeofenceAlertPayload) => void;
  'alert:info': (payload: GeofenceAlertPayload) => void;
  'alert:clear': (payload: GeofenceClearPayload) => void;
  'supervisor:alert': (payload: SupervisorGeofenceAlertPayload) => void;

  'signal:lost:level1': (payload: SignalLostPayload) => void;
  'signal:lost:level2': (payload: SignalLostPayload) => void;
  'signal:recovered': (payload: SignalRecoveredPayload) => void;
  'supervisor:signal_lost': (payload: SupervisorSignalLostPayload) => void;

  'collision:proximity': (payload: CollisionPayload) => void;
  'collision:critical': (payload: CollisionPayload) => void;
  'collision:clear': (payload: CollisionClearPayload) => void;
  'supervisor:collision': (payload: SupervisorCollisionPayload) => void;

  'proximity:distance_update': (payload: ProximityDistanceUpdatePayload) => void;
  'proximity:warning': (payload: ProximityPayload) => void;
  'proximity:critical': (payload: ProximityPayload) => void;
  'proximity:clear': (payload: ProximityClearPayload) => void;
  'supervisor:proximity': (payload: SupervisorProximityPayload) => void;

  'fleet:preventive_stop': (payload: PreventiveStopActivePayload) => void;
  'fleet:preventive_stop_clear': (payload: PreventiveStopClearPayload) => void;
  'supervisor:preventive_stop': (payload: SupervisorPreventiveStopPayload) => void;

  'equipment:approach_outer': (payload: EquipmentApproachPayload) => void;
  'equipment:approach_inner': (payload: EquipmentApproachPayload) => void;
  'equipment:minimum_limit': (payload: EquipmentApproachPayload) => void;
  'equipment:distance_update': (payload: EquipmentDistanceUpdatePayload) => void;
  'equipment:approach_clear': (payload: EquipmentApproachClearPayload) => void;
  'equipment:vehicle_approaching': (payload: EquipmentVehicleApproachingPayload) => void;
  'equipment:status_update': (payload: EquipmentStatusUpdatePayload) => void;

  'incident:reported': (payload: IncidentReportedPayload) => void;
  'incident:resolved': (payload: IncidentResolvedPayload) => void;
  'incident:nearby': (payload: IncidentNearbyPayload) => void;
  'supervisor:incident': (payload: SupervisorIncidentPayload) => void;

  'alerts:snapshot': (entries: AlertEventEntry[]) => void;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- el backend es receive-only, nunca escucha eventos de los clientes
export interface ClientToServerEvents {}
