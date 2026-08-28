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

export type NtripVersion = 'v1' | 'v2';

export interface NtripConfig {
  host: string;
  port: number;
  mountpoint: string;
  username: string;
  password: string;
  version: NtripVersion;
}

export type RtkFixLabel = 'SIN_FIX' | 'GPS' | 'DGPS' | 'RTK_FLOAT' | 'RTK_FIX';

export interface RtkFix {
  // null mientras el receptor no tiene ningun tipo de fix ("buscando satelites") - el resto de
  // los campos (satelites/hdop/fixLabel) siguen siendo reales aunque todavia no haya posicion
  latitude: number | null;
  longitude: number | null;
  fixQuality: number;
  fixLabel: RtkFixLabel;
  satellites: number;
  hdop: number | null;
  accuracyMeters: number;
}

// "ntrip" es el unico modo funcional hoy - pointperfect/usb_serial existen para que el selector no
// se tenga que rehacer despues, pero se muestran bloqueados "proximamente" en el front
export type CorrectionMode = 'ntrip' | 'pointperfect' | 'usb_serial';

export interface RtkStatus {
  usbConnected: boolean;
  connectedUsbDeviceName: string | null;
  usbDataRateBps: number;
  usbTotalBytes: number;
  ntripConnected: boolean;
  ntripError: string | null;
  ntripDataRateBps: number;
  ntripTotalBytes: number;
  mockLocationActive: boolean;
  swMapsOutputRunning: boolean;
  swMapsPort: number;
  correctionMode: CorrectionMode;
  // activado por el codigo de configuracion rapida - mientras este en true, conectar el USB
  // dispara solo NTRIP+ubicacion simulada, y desconectarlo los apaga solo, sin intervencion manual
  autoModeEnabled: boolean;
  lastFix?: RtkFix;
}

// una fila "STR;..." de la sourcetable NTRIP estandar - GET / (sin mountpoint) contra cualquier
// caster real regresa esta lista, no hace falta escribir el mountpoint a mano
export interface NtripMountpoint {
  mountpoint: string;
  identifier: string;
  format: string;
  navSystem: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  nmeaRequired: boolean;
}

export interface RtkNtripPlugin {
  listUsbDevices(): Promise<{ devices: UsbDeviceInfo[] }>;
  connectUsb(options: { deviceId: number; baudRate?: number }): Promise<void>;
  disconnectUsb(): Promise<void>;
  getBaudRate(): Promise<{ baudRate: number }>;
  setBaudRate(options: { baudRate: number }): Promise<void>;
  setNtripConfig(options: NtripConfig): Promise<void>;
  getNtripConfig(): Promise<Partial<NtripConfig>>;
  fetchSourceTable(options: { host: string; port: number }): Promise<{ mountpoints: NtripMountpoint[] }>;
  getCorrectionMode(): Promise<{ mode: CorrectionMode }>;
  setCorrectionMode(options: { mode: CorrectionMode }): Promise<void>;
  startNtrip(): Promise<void>;
  stopNtrip(): Promise<void>;
  getAutoMode(): Promise<{ enabled: boolean }>;
  setAutoMode(options: { enabled: boolean }): Promise<void>;
  startMockLocation(): Promise<void>;
  stopMockLocation(): Promise<void>;
  startSwMapsOutput(options?: { port?: number }): Promise<void>;
  stopSwMapsOutput(): Promise<void>;
  getStatus(): Promise<RtkStatus>;
  addListener(
    eventName: 'rtkStatus',
    listenerFunc: (status: RtkStatus) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'usbDevicesChanged',
    listenerFunc: (data: { devices: UsbDeviceInfo[] }) => void,
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
  getBaudRate: async () => ({ baudRate: 460800 }),
  setBaudRate: async () => unavailable('RtkNtrip'),
  setNtripConfig: async () => unavailable('RtkNtrip'),
  getNtripConfig: async () => ({}),
  fetchSourceTable: async () => unavailable('RtkNtrip'),
  getCorrectionMode: async () => ({ mode: 'ntrip' }),
  setCorrectionMode: async () => unavailable('RtkNtrip'),
  startNtrip: async () => unavailable('RtkNtrip'),
  stopNtrip: async () => unavailable('RtkNtrip'),
  getAutoMode: async () => ({ enabled: false }),
  setAutoMode: async () => unavailable('RtkNtrip'),
  startMockLocation: async () => unavailable('RtkNtrip'),
  stopMockLocation: async () => unavailable('RtkNtrip'),
  startSwMapsOutput: async () => unavailable('RtkNtrip'),
  stopSwMapsOutput: async () => unavailable('RtkNtrip'),
  getStatus: async () => ({
    usbConnected: false,
    connectedUsbDeviceName: null,
    usbDataRateBps: 0,
    usbTotalBytes: 0,
    ntripConnected: false,
    ntripError: null,
    ntripDataRateBps: 0,
    ntripTotalBytes: 0,
    mockLocationActive: false,
    swMapsOutputRunning: false,
    swMapsPort: 11123,
    correctionMode: 'ntrip',
    autoModeEnabled: false,
  }),
  addListener: (async () => ({ remove: async () => {} })) as RtkNtripPlugin['addListener'],
};

export const TraccarSender = registerPlugin<TraccarSenderPlugin>('TraccarSender', {
  web: webTraccarFallback,
});

export const RtkNtrip = registerPlugin<RtkNtripPlugin>('RtkNtrip', {
  web: webRtkFallback,
});
