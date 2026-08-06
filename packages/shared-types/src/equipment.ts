export type EquipmentStatus = 'active_swing' | 'active_pause' | 'inactive';

/**
 * Forma en memoria de un equipo estático (pala/excavadora) — la que
 * produce StaticEquipmentManager y viaja por el evento de Socket.io
 * `equipment:update`. Ver
 * apps/backend/src/services/static_equipment/StaticEquipmentManager.ts.
 */
export interface StaticEquipment {
  id: number;
  name: string;
  type: string;
  lat: number;
  lon: number;
  swingRadius: number;
  safetyRadius: number;
  status: EquipmentStatus;
}
