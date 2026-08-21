import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

export interface TraccarServer {
  id: string;
  url: string;
  enabled: boolean;
}

export interface TraccarSenderState {
  running: boolean;
  lastSentAt: number;
  lastError: string | null;
}

export interface TraccarSenderPlugin {
  getServers(): Promise<{ servers: TraccarServer[] }>;
  saveServers(options: { servers: TraccarServer[] }): Promise<void>;
  setDeviceId(options: { deviceId: string }): Promise<void>;
  setInterval(options: { intervalMs: number }): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): Promise<TraccarSenderState>;
}

export interface UsbDeviceInfo {
  deviceId: number;
  vendorId: number;
  productId: number;
  name: string | null;
}

export interface NtripConfig {
  host: string;
  port: number;
  mountpoint: string;
  username: string;
  password: string;
}

export type RtkFixLabel = 'SIN_FIX' | 'GPS' | 'DGPS' | 'RTK_FLOAT' | 'RTK_FIX';

export interface RtkFix {
  latitude: number;
  longitude: number;
  fixQuality: number;
  fixLabel: RtkFixLabel;
  satellites: number;
  hdop: number | null;
  accuracyMeters: number;
}

export interface RtkStatus {
  usbConnected: boolean;
  ntripConnected: boolean;
  ntripError: string | null;
  lastFix?: RtkFix;
}

export interface RtkNtripPlugin {
  listUsbDevices(): Promise<{ devices: UsbDeviceInfo[] }>;
  connectUsb(options: { deviceId: number; baudRate?: number }): Promise<void>;
  disconnectUsb(): Promise<void>;
  setNtripConfig(options: NtripConfig): Promise<void>;
  getNtripConfig(): Promise<Partial<NtripConfig>>;
  startNtrip(): Promise<void>;
  stopNtrip(): Promise<void>;
  startMockLocation(): Promise<void>;
  stopMockLocation(): Promise<void>;
  getStatus(): Promise<RtkStatus>;
  addListener(
    eventName: 'rtkStatus',
    listenerFunc: (status: RtkStatus) => void,
  ): Promise<PluginListenerHandle>;
}

// fuera de la app nativa (navegador normal, tablet sin app instalada) no hay plugin real - se
// rechaza con un mensaje claro en vez de que el bundle web reviente por falta del plugin nativo
function unavailable(name: string): never {
  throw new Error(`${name} solo esta disponible dentro de la app Android GAGA Operador`);
}

const webTraccarFallback: TraccarSenderPlugin = {
  getServers: async () => ({ servers: [] }),
  saveServers: async () => unavailable('TraccarSender'),
  setDeviceId: async () => unavailable('TraccarSender'),
  setInterval: async () => unavailable('TraccarSender'),
  start: async () => unavailable('TraccarSender'),
  stop: async () => unavailable('TraccarSender'),
  getState: async () => ({ running: false, lastSentAt: 0, lastError: null }),
};

const webRtkFallback: RtkNtripPlugin = {
  listUsbDevices: async () => ({ devices: [] }),
  connectUsb: async () => unavailable('RtkNtrip'),
  disconnectUsb: async () => unavailable('RtkNtrip'),
  setNtripConfig: async () => unavailable('RtkNtrip'),
  getNtripConfig: async () => ({}),
  startNtrip: async () => unavailable('RtkNtrip'),
  stopNtrip: async () => unavailable('RtkNtrip'),
  startMockLocation: async () => unavailable('RtkNtrip'),
  stopMockLocation: async () => unavailable('RtkNtrip'),
  getStatus: async () => ({ usbConnected: false, ntripConnected: false, ntripError: null }),
  addListener: async () => ({ remove: async () => {} }),
};

export const TraccarSender = registerPlugin<TraccarSenderPlugin>('TraccarSender', {
  web: webTraccarFallback,
});

export const RtkNtrip = registerPlugin<RtkNtripPlugin>('RtkNtrip', {
  web: webRtkFallback,
});
