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
  // true = puerto CDC-ACM nativo (el USB propio del receptor u-blox, sin chip puente detras) - el
  // firmware no tiene concepto de baud rate ahi, cambiarlo no hace nada real. false = un chip
  // puente de verdad (FTDI/CP210x/CH340/Prolific), donde el baud si importa.
  hasFixedBaud: boolean;
}

// modulo Bluetooth del receptor RTK (HC-05 sobre SPP) - solo dispositivos YA vinculados desde
// Ajustes de Android; la app nunca descubre ni empareja, por eso no pide BLUETOOTH_SCAN
export interface BluetoothDeviceInfo {
  address: string;
  name: string | null;
  connected: boolean;
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
  // hora UTC real del GPS (de RMC) - distinta del reloj de la tableta, util para confirmar que
  // el receptor tiene hora GPS real en vez de comparar contra si mismo sin decir nada util
  gpsTimeMs: number | null;
  // altitud MSL (nivel del mar), tal cual la GGA. Ver ellipsoidalAltitudeMeters para la otra.
  altitude: number | null;
  // altitud sobre el elipsoide WGS84 - lo que u-center llama "Altitude" a secas (distinto de
  // "Altitude (msl)"). null si la GGA no trae separacion geoidal (siempre deberia traerla)
  ellipsoidalAltitudeMeters: number | null;
  // rumbo/velocidad del ultimo fix - null hasta el primer RMC. Igual que el resto de este puente,
  // separado del canal rapido rtkFix (RtkFixEvent) - este es para el panel de diagnostico (1/seg),
  // no para el marcador propio en el mapa (hasta 10/seg)
  speedMps: number | null;
  courseDeg: number | null;
  fixQuality: number;
  fixLabel: RtkFixLabel;
  satellites: number;
  hdop: number | null;
  accuracyMeters: number;
  // error horizontal REAL del receptor (GST). null si GST no esta habilitado en el receptor, y
  // entonces accuracyMeters cae a una estimacion por tipo de fix en vez de una medicion
  horizontalStdMeters: number | null;
  // error 3D (horizontal + vertical) real del receptor (GST). Mismo criterio que horizontalStdMeters
  fullStdMeters: number | null;
  // segundos desde la ultima correccion aplicada, y estacion base que la emitio (campos 14 y 15
  // de la GGA). Arriba de 2-5s el RTK se degrada aunque el NTRIP siga "conectado"
  correctionAgeSeconds: number | null;
  stationId: string | null;
}

// un satelite a la vista. signalId distingue la banda (1 = L1C/A, 6 = GPS L2 CL, 3 = GLONASS
// L2 OF...), asi que un mismo satelite aparece dos veces si se rastrea en dos frecuencias
export interface SatelliteInfo {
  constellation: string;
  id: number;
  elevation: number | null;
  azimuth: number | null;
  snr: number | null; // dB-Hz. RTK necesita 35-45; null = rastreado sin medida
  signalId: number;
  used: boolean; // entra al calculo de posicion (viene de GSA)
}

// "ntrip" es el unico modo funcional hoy - pointperfect/usb_serial existen para que el selector no
// se tenga que rehacer despues, pero se muestran bloqueados "proximamente" en el front
export type CorrectionMode = 'ntrip' | 'pointperfect' | 'usb_serial';

// fix real del receptor, emitido al ritmo que el propio receptor lo entrega (5-10Hz tipico) - a
// diferencia de rtkStatus (solo cambia de vez en cuando), esto llega en cada fix, para que la
// posicion local pueda refrescarse mas rapido que navigator.geolocation.watchPosition (que en la
// practica el navegador entrega ~1/seg sin importar que tan rapido produzca fixes el hardware)
export interface RtkFixEvent {
  latitude: number;
  longitude: number;
  speedMps?: number;
  courseDeg?: number;
  accuracyMeters: number;
  timestamp: number;
}

export interface RtkStatus {
  usbConnected: boolean;
  connectedUsbDeviceName: string | null;
  // id del dispositivo USB conectado (mismo campo que UsbDeviceInfo.deviceId) - para saber cual
  // fila de la lista es "la conectada" sin depender de un name que puede repetirse entre 2
  // receptores identicos
  connectedUsbDeviceId: number | null;
  usbDataRateBps: number;
  usbTotalBytes: number;
  // transporte Bluetooth, alternativa al cable USB. El baud rate no aparece aqui a proposito: vive
  // entre el HC-05 y el UART2 del receptor, Android solo abre el socket serial.
  bluetoothSupported: boolean;
  bluetoothEnabled: boolean;
  bluetoothPermissionGranted: boolean;
  bluetoothConnected: boolean;
  connectedBluetoothName: string | null;
  connectedBluetoothAddress: string | null;
  bluetoothDataRateBps: number;
  bluetoothTotalBytes: number;
  ntripConnected: boolean;
  ntripError: string | null;
  ntripDataRateBps: number;
  ntripTotalBytes: number;
  mockLocationActive: boolean;
  // permiso real de Android (AppOps) - a diferencia de mockLocationActive (si ESTE proceso ya
  // arranco el feed), esto refleja si "Seleccionar app de ubicacion falsa" ya apunta a esta app,
  // sin cambiar con reinicios de la app. Es lo que debe decidir si el checklist de Ajustes se
  // muestra o no - ver DeviceSettingsPanel.tsx.
  mockLocationAllowed: boolean;
  swMapsOutputRunning: boolean;
  swMapsPort: number;
  correctionMode: CorrectionMode;
  lastFix?: RtkFix;
  // solo vienen en getStatus(), nunca en el evento rtkStatus - ese sale hasta 10 veces por segundo
  // y la lista de satelites es pesada de cruzar el puente a esa frecuencia
  satellites?: SatelliteInfo[];
  pdop?: number | null;
  hdop?: number | null;
  vdop?: number | null;
  // 2 o 3 (de GSA), null si nunca llego un GSA valido
  dimension?: number | null;
  // TTFF aproximado desde que se establecio el enlace actual - ver comentario en RtkNtripPlugin.kt
  ttffMs?: number | null;
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
  listBluetoothDevices(): Promise<{ devices: BluetoothDeviceInfo[] }>;
  connectBluetooth(options: { address: string }): Promise<void>;
  disconnectBluetooth(): Promise<void>;
  // en una tableta Device Owner se concede sin dialogo; si no, abre el dialogo normal de Android
  requestBluetoothPermission(): Promise<void>;
  getBaudRate(): Promise<{ baudRate: number }>;
  setBaudRate(options: { baudRate: number }): Promise<void>;
  setNtripConfig(options: NtripConfig): Promise<void>;
  getNtripConfig(): Promise<Partial<NtripConfig>>;
  fetchSourceTable(options: { host: string; port: number }): Promise<{ mountpoints: NtripMountpoint[] }>;
  getCorrectionMode(): Promise<{ mode: CorrectionMode }>;
  setCorrectionMode(options: { mode: CorrectionMode }): Promise<void>;
  startNtrip(): Promise<void>;
  stopNtrip(): Promise<void>;
  // rumbo ya corregido por la auto-calibracion de montaje (ver headingCalibration.ts) - lo usa el
  // envio al servidor cuando el rumbo GPS no es confiable (vehiculo detenido), para que Admin y
  // Supervisor vean hacia donde apunta el vehiculo igual que el operador en su propia pantalla
  setCompassHeading(options: { headingDeg: number }): Promise<void>;
  startMockLocation(): Promise<void>;
  stopMockLocation(): Promise<void>;
  startSwMapsOutput(options?: { port?: number }): Promise<void>;
  stopSwMapsOutput(): Promise<void>;
  getStatus(): Promise<RtkStatus>;
  // mientras esta activo, el evento rtkStatus (hasta 10Hz) tambien trae satelites/DOP/TTFF - solo
  // se activa mientras el menu u-center esta abierto (ver UCenterView.tsx), apagado el resto del
  // tiempo para no cruzar esa lista por el puente sin que nadie la vea
  setDiagnosticsActive(options: { active: boolean }): Promise<void>;
  addListener(
    eventName: 'rtkStatus',
    listenerFunc: (status: RtkStatus) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'usbDevicesChanged',
    listenerFunc: (data: { devices: UsbDeviceInfo[] }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'bluetoothDevicesChanged',
    listenerFunc: (data: { devices: BluetoothDeviceInfo[] }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'rtkFix',
    listenerFunc: (fix: RtkFixEvent) => void,
  ): Promise<PluginListenerHandle>;
  // mismo fix exacto que TraccarSenderService manda al servidor (GPS_PROVIDER crudo o el
  // respaldo de red) - garantiza que el marcador propio del Operador coincida con lo que
  // Admin/Supervisor ven desde el servidor, sin depender de que navigator.geolocation resuelva
  // igual (normalmente usa Fused Location de Play Services, GPS+red combinados, que puede diferir)
  addListener(
    eventName: 'gpsFix',
    listenerFunc: (fix: RtkFixEvent) => void,
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
  listBluetoothDevices: async () => ({ devices: [] }),
  connectBluetooth: async () => unavailable('RtkNtrip'),
  disconnectBluetooth: async () => unavailable('RtkNtrip'),
  requestBluetoothPermission: async () => unavailable('RtkNtrip'),
  getBaudRate: async () => ({ baudRate: 460800 }),
  setBaudRate: async () => unavailable('RtkNtrip'),
  setNtripConfig: async () => unavailable('RtkNtrip'),
  getNtripConfig: async () => ({}),
  fetchSourceTable: async () => unavailable('RtkNtrip'),
  getCorrectionMode: async () => ({ mode: 'ntrip' }),
  setCorrectionMode: async () => unavailable('RtkNtrip'),
  startNtrip: async () => unavailable('RtkNtrip'),
  stopNtrip: async () => unavailable('RtkNtrip'),
  setCompassHeading: async () => unavailable('RtkNtrip'),
  startMockLocation: async () => unavailable('RtkNtrip'),
  stopMockLocation: async () => unavailable('RtkNtrip'),
  startSwMapsOutput: async () => unavailable('RtkNtrip'),
  stopSwMapsOutput: async () => unavailable('RtkNtrip'),
  setDiagnosticsActive: async () => unavailable('RtkNtrip'),
  getStatus: async () => ({
    usbConnected: false,
    connectedUsbDeviceName: null,
    connectedUsbDeviceId: null,
    usbDataRateBps: 0,
    usbTotalBytes: 0,
    bluetoothSupported: false,
    bluetoothEnabled: false,
    bluetoothPermissionGranted: false,
    bluetoothConnected: false,
    connectedBluetoothName: null,
    connectedBluetoothAddress: null,
    bluetoothDataRateBps: 0,
    bluetoothTotalBytes: 0,
    ntripConnected: false,
    ntripError: null,
    ntripDataRateBps: 0,
    ntripTotalBytes: 0,
    mockLocationActive: false,
    mockLocationAllowed: false,
    swMapsOutputRunning: false,
    swMapsPort: 11123,
    correctionMode: 'ntrip',
  }),
  addListener: (async () => ({ remove: async () => {} })) as RtkNtripPlugin['addListener'],
};

export interface KioskStatus {
  // true solo si la app ya se aprovisiono como Device Owner (comando adb, o el QR de
  // aprovisionamiento - ver SystemSection.tsx/KioskAdminReceiver.kt) - sin esto, enable() rechaza
  // y el modo kiosko no puede activarse desde la UI
  isDeviceOwner: boolean;
  enabled: boolean; // preferencia guardada - "debe reentrar al kiosko en cada arranque"
  active: boolean; // Lock Task Mode realmente activo en este momento
  // "Opciones de desarrollador" del sistema - prerequisito real para elegir esta app como
  // ubicacion simulada (RTK), sin relacion directa con Device Owner. Ninguna app puede activarlo
  // solo, ver openDeveloperOptions()/checklist en DeviceSettingsPanel.tsx
  developerOptionsEnabled: boolean;
  // true si esta tableta se convirtio en Device Owner via el QR de aprovisionamiento (no via adb) -
  // la web lo usa para aprovisionarse sola al primer arranque, sin pedir el codigo de "Modo Operador"
  wasQrProvisioned: boolean;
  // SCHEDULE_EXACT_ALARM concedido - bug real confirmado en hardware: Device Owner NO lo recibe
  // otorgado solo (verificado contra documentacion oficial de Android 14, contrario a lo asumido
  // antes) - sin esto, la suspension por perdida de corriente cae a un temporizador inexacto que
  // Android puede retrasar varios segundos/minutos (26s en vez de 15, confirmado con log real).
  // Ver openExactAlarmSettings()/checklist en DeviceSettingsPanel.tsx
  exactAlarmsGranted: boolean;
}

export interface KioskPlugin {
  getStatus(): Promise<KioskStatus>;
  enable(): Promise<void>;
  disable(): Promise<void>;
  openDeveloperOptions(): Promise<void>;
  openExactAlarmSettings(): Promise<void>;
  // renuncia a Device Owner desde dentro de la app - unica forma confiable de desbloquear la
  // desinstalacion normal sin un reseteo de fabrica completo (adb shell dpm remove-active-admin y
  // pm clear estan bloqueados por el shell en builds de produccion, confirmado en hardware real)
  releaseDeviceOwner(): Promise<void>;
}

const webKioskFallback: KioskPlugin = {
  getStatus: async () => ({
    isDeviceOwner: false,
    enabled: false,
    active: false,
    developerOptionsEnabled: false,
    wasQrProvisioned: false,
    exactAlarmsGranted: false,
  }),
  enable: async () => unavailable('Kiosk'),
  disable: async () => unavailable('Kiosk'),
  openDeveloperOptions: async () => unavailable('Kiosk'),
  openExactAlarmSettings: async () => unavailable('Kiosk'),
  releaseDeviceOwner: async () => unavailable('Kiosk'),
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

export interface PowerStatus {
  // true mientras la tableta esta en suspension profunda por perdida de corriente (ver
  // power/PowerSuspendAlarmReceiver.kt) - GPS/RTK/pantalla apagados. useOperatorSocket.ts usa
  // esto para desconectar su propio socket mientras dure, sin eso la suspension no es total.
  suspended: boolean;
}

export interface PowerPlugin {
  getStatus(): Promise<PowerStatus>;
  addListener(
    eventName: 'powerStatus',
    listenerFunc: (status: PowerStatus) => void,
  ): Promise<PluginListenerHandle>;
}

const webPowerFallback: PowerPlugin = {
  getStatus: async () => ({ suspended: false }),
  addListener: (async () => ({ remove: async () => {} })) as PowerPlugin['addListener'],
};

export const Power = registerPlugin<PowerPlugin>('Power', {
  web: webPowerFallback,
});
