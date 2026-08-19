import type { LineString, Polygon } from 'geojson';

export interface ProjectRow {
  id: number;
  name: string;
  active: boolean;
  created_at: string;
}

export interface ShiftRow {
  id: number;
  project_id: number;
  name: string;
  start_time: string;
  end_time: string;
  supervisor_user_id: number | null;
  active: boolean;
}

export interface DeviceRow {
  id: number;
  unique_id: string;
  name: string;
  type: string;
  status: string;
  project_id: number | null;
  last_update: string | null;
}

export type GeofenceShapeType = 'circle' | 'polygon' | 'polyline';

export interface GeofenceRow {
  id: number;
  name: string;
  type: 'warning' | 'danger' | 'parking';
  shape_type: GeofenceShapeType;
  active: boolean;
  project_id: number | null;
  center_lat: number | null;
  center_lon: number | null;
  radius_meters: number | null;
  geometry: Polygon | LineString | null;
  corridor_width_meters: number | null;
  corridor_danger_margin_meters: number | null;
}

export interface EquipmentRow {
  id: number;
  name: string;
  type: string;
  project_id: number | null;
  latitude: number;
  longitude: number;
  swing_radius: number;
  safety_radius: number;
  status: 'active_swing' | 'active_pause' | 'inactive';
  linked_device_id: string | null;
}

export type MapStatus = 'processing' | 'ready' | 'failed';

export interface MapRow {
  id: number;
  name: string;
  project_id: number | null;
  status: MapStatus;
  source_crs: string | null;
  crs_auto_detected: boolean | null;
  bounds: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null;
  min_zoom: number | null;
  max_zoom: number | null;
  size_mb: number | null;
  error_message: string | null;
  active: boolean;
  created_at: string;
}

export interface UserRow {
  id: number;
  email: string;
  name: string;
  role: string;
  project_id: number | null;
  active: boolean;
}

export interface HistoryPoint {
  fix_time: string;
  latitude: number;
  longitude: number;
  speed: number;
  course: number;
  altitude: number;
  accuracy: number;
  battery: number | null;
  zones: { id: number; name: string; type: string }[];
}

export interface HealthResponse {
  status: string;
  timestamp: string;
  services: Record<string, unknown>;
}
