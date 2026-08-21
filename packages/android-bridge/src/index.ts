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
  bufferedCount: number;
}

// deliberadamente minimo - GPS y buffer/wakelock siempre estan forzados al mejor modo posible
// (ver TraccarSenderService/TraccarUplink en la app nativa), no se ofrecen ajustes que solo
// serian "peor que el default" (precision baja, sin buffer, etc)
export interface TraccarSendSettings {
  intervalSeconds: number;
  password: string;
}

export interface TraccarLogEntry {
  timestamp: number;
  serverUrl: string;
  success: boolean;
  message: string;
}

export interface TraccarSenderPlugin {
  getServers(): Promise<{ servers: TraccarServer[] }>;
  saveServers(options: { servers: TraccarServer[] }): Promise<void>;
  setDeviceId(options: { deviceId: string }): Promise<void>;
  getSendSettings(): Promise<TraccarSendSettings>;
  setSendSettings(options: Partial<TraccarSendSettings>): Promise<void>;
  resetSendSettings(): Promise<TraccarSendSettings>;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendNow(): Promise<TraccarSenderState>;
  getState(): Promise<TraccarSenderState>;
  getLog(): Promise<{ entries: TraccarLogEntry[] }>;
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

const defaultSendSettings: TraccarSendSettings = {
  intervalSeconds: 1,
  password: '',
};

const webTraccarFallback: TraccarSenderPlugin = {
  getServers: async () => ({ servers: [] }),
  saveServers: async () => unavailable('TraccarSender'),
  setDeviceId: async () => unavailable('TraccarSender'),
  getSendSettings: async () => defaultSendSettings,
  setSendSettings: async () => unavailable('TraccarSender'),
  resetSendSettings: async () => defaultSendSettings,
  start: async () => unavailable('TraccarSender'),
  stop: async () => unavailable('TraccarSender'),
  sendNow: async () => unavailable('TraccarSender'),
  getState: async () => ({ running: false, lastSentAt: 0, lastError: null, bufferedCount: 0 }),
  getLog: async () => ({ entries: [] }),
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
