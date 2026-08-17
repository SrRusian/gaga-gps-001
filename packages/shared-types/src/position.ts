/**
 * Forma de una posición GPS ya normalizada - la que produce
 * telemetry.routes.js a partir del protocolo OsmAnd, la que procesa
 * PositionProcessor, y la que viaja por Socket.io (`fleet:update`)
 * hacia Operador/Supervisor.
 */
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
  /** Enriquecido por DeviceManager antes de persistir/emitir. */
  deviceName?: string;
  deviceType?: string;
  /** Proyecto del dispositivo - filtra la hidratación de flota por aislamiento multi-tenencia. */
  projectId?: number | null;
}

/** Estado en vivo de toda la flota - keyed por deviceId, guardado en Redis. */
export type FleetState = Record<string, Position>;
