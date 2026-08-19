export type EquipmentStatus = 'active_swing' | 'active_pause' | 'inactive';

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
