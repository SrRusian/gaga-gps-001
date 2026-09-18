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
  GeofenceProximityClearPayload,
  GeofenceProximityNoticePayload,
  IncidentNearbyPayload,
  IncidentReportedPayload,
  IncidentResolvedPayload,
  PreventiveStopActivePayload,
  PreventiveStopClearPayload,
  ProximityClearPayload,
  ProximityDistanceUpdatePayload,
  ProximityPayload,
  RouteDistanceClearPayload,
  RouteDistanceUpdatePayload,
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

  // aviso silencioso de proximidad a geocerca peligrosa - solo llega al operador afectado
  // (sendToDevice), canal propio deliberadamente separado de alert:*/alert:clear de arriba
  'alert:proximity_notice': (payload: GeofenceProximityNoticePayload) => void;
  'alert:proximity_clear': (payload: GeofenceProximityClearPayload) => void;

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

  // distancia continua al vehiculo mas cercano en la MISMA ruta autorizada - solo al operador
  // afectado (sendToDevice), ver RouteDistanceUpdatePayload
  'route:distance_update': (payload: RouteDistanceUpdatePayload) => void;
  'route:distance_clear': (payload: RouteDistanceClearPayload) => void;

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

  // "actualizar ahora" pedido desde el panel de Sistema (ver app-update.routes.ts POST
  // /force-update) - solo lo recibe la tableta si su socket esta conectado en este momento
  'device:force_update': () => void;
}

export interface DeviceHelloPayload {
  deviceId: string;
}

// unico evento que el backend escucha de los clientes hoy - le dice a FleetSocketServer a que
// "cuarto" (deviceId) unirse, para poder dirigir device:force_update a una tableta en concreto
export interface ClientToServerEvents {
  'device:hello': (payload: DeviceHelloPayload) => void;
}
