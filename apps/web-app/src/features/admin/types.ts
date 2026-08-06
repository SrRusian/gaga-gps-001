/**
 * DTOs tal como los devuelve la API del panel Admin — filas crudas
 * de PostgreSQL (snake_case), distintas de las formas normalizadas
 * de @gaga-gps/shared-types que usan Operador/Supervisor en tiempo
 * real. Ver los repositorios correspondientes en apps/backend.
 */
import type { LineString, Polygon } from 'geojson';

export interface DeviceRow {
  id: number;
  unique_id: string;
  name: string;
  type: string;
  status: string;
  last_update: string | null;
}

export type GeofenceShapeType = 'circle' | 'polygon' | 'polyline';

export interface GeofenceRow {
  id: number;
  name: string;
  type: 'warning' | 'danger';
  shape_type: GeofenceShapeType;
  active: boolean;
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
  latitude: number;
  longitude: number;
  swing_radius: number;
  safety_radius: number;
  status: 'active_swing' | 'active_pause' | 'inactive';
}

export type MapStatus = 'processing' | 'ready' | 'failed';

export interface MapRow {
  id: number;
  name: string;
  status: MapStatus;
  source_crs: string | null;
  crs_auto_detected: boolean | null;
  size_mb: number | null;
  error_message: string | null;
  active: boolean;
  created_at: string;
}

export interface UserRow {
  id: number;
  email: string;
  name: string;
  role: 'operator' | 'supervisor' | 'admin';
  active: boolean;
}

export interface HistoryPoint {
  fix_time: string;
  latitude: number;
  longitude: number;
  speed: number;
  zones: { id: number; name: string; type: string }[];
}

export interface HealthResponse {
  status: string;
  timestamp: string;
  services: Record<string, unknown>;
}
