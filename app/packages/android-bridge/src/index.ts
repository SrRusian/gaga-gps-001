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
  // id del dispositivo USB conectado (mismo campo que UsbDeviceInfo.deviceId) - para saber cual
  // fila de la lista es "la conectada" sin depender de un name que puede repetirse entre 2
  // receptores identicos
  connectedUsbDeviceId: number | null;
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
  startMockLocation: async () => unavailable('RtkNtrip'),
  stopMockLocation: async () => unavailable('RtkNtrip'),
  startSwMapsOutput: async () => unavailable('RtkNtrip'),
  stopSwMapsOutput: async () => unavailable('RtkNtrip'),
  getStatus: async () => ({
    usbConnected: false,
    connectedUsbDeviceName: null,
    connectedUsbDeviceId: null,
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
  }),
  addListener: (async () => ({ remove: async () => {} })) as RtkNtripPlugin['addListener'],
};

export interface KioskStatus {
  // true solo si la app ya se aprovisiono como Device Owner (comando adb, una sola vez por
  // tableta) - sin esto, enable() rechaza y el modo kiosko no puede activarse desde la UI
  isDeviceOwner: boolean;
  enabled: boolean; // preferencia guardada - "debe reentrar al kiosko en cada arranque"
  active: boolean; // Lock Task Mode realmente activo en este momento
}

export interface KioskPlugin {
  getStatus(): Promise<KioskStatus>;
  enable(): Promise<void>;
  disable(): Promise<void>;
}

const webKioskFallback: KioskPlugin = {
  getStatus: async () => ({ isDeviceOwner: false, enabled: false, active: false }),
  enable: async () => unavailable('Kiosk'),
  disable: async () => unavailable('Kiosk'),
};

export interface AppUpdateStatus {
  enabled: boolean;
  currentVersionCode: number;
  currentVersionName: string;
  // ultimo manifest visto en el servidor - null si nunca se pudo consultar todavia
  latestVersionCode: number | null;
  latestVersionName: string | null;
  checking: boolean;
  lastCheckAt: number | null;
  lastError: string | null;
}

export interface AppUpdatePlugin {
  // apiBaseUrl+key vienen del mismo perfil de servidor ya configurado en "Servidor e identidad" -
  // no es una clave nueva, es el TELEMETRY_SHARED_SECRET que la tableta ya conoce como "token"
  configure(options: { apiBaseUrl: string; key: string; enabled: boolean }): Promise<void>;
  checkNow(): Promise<void>;
  getStatus(): Promise<AppUpdateStatus>;
}

const webAppUpdateFallback: AppUpdatePlugin = {
  configure: async () => unavailable('AppUpdate'),
  checkNow: async () => unavailable('AppUpdate'),
  getStatus: async () => ({
    enabled: false,
    currentVersionCode: 0,
    currentVersionName: '',
    latestVersionCode: null,
    latestVersionName: null,
    checking: false,
    lastCheckAt: null,
    lastError: null,
  }),
};

export const TraccarSender = registerPlugin<TraccarSenderPlugin>('TraccarSender', {
  web: webTraccarFallback,
});

export const RtkNtrip = registerPlugin<RtkNtripPlugin>('RtkNtrip', {
  web: webRtkFallback,
});

export const Kiosk = registerPlugin<KioskPlugin>('Kiosk', {
  web: webKioskFallback,
});

export const AppUpdate = registerPlugin<AppUpdatePlugin>('AppUpdate', {
  web: webAppUpdateFallback,
});
