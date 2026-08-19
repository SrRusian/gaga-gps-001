export interface Position {
  deviceId: string;
  latitude: number;
  longitude: number;
  altitude?: number;
  speed?: number;
  course?: number;
  accuracy?: number;
  battery?: number | null;
  fixTime: Date | string;
  protocol?: string;
  valid?: boolean;
  attributes?: Record<string, unknown>;
  deviceName?: string;
  deviceType?: string;
  projectId?: number | null;
}

export type FleetState = Record<string, Position>;
