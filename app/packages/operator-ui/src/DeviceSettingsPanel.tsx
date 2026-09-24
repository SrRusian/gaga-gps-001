import {
  AppUpdate,
  Kiosk,
  RtkNtrip,
  TraccarSender,
  type AppUpdateStatus,
  type KioskStatus,
  type NtripMountpoint,
  type RtkStatus,
  type TraccarLogEntry,
  type TraccarSendSettings,
  type TraccarServer,
  type UsbDeviceInfo,
} from '@gaga-gps/android-bridge';
import {
  deleteServerProfile,
  enableOperatorMode,
  getActiveServerProfileId,
  getDeviceId,
  getSettingsPassword,
  getStoredApiBaseUrl,
  getTelemetryToken,
  hasSettingsPassword,
  isOperatorModeEnabled,
  listServerProfiles,
  PRODUCTION_SERVER_URL,
  setActiveServerProfileId,
  setApiBaseUrl,
  setDeviceId,
  setSettingsPassword,
  setTelemetryToken,
  upsertServerProfile,
  type ServerProfile,
} from '@gaga-gps/client';
import { useEffect, useState } from 'react';
import { UCenterView } from './UCenterView';
import './device-settings.css';
import {
  deleteNtripProfile,
  getActiveNtripProfileId,
  listNtripProfiles,
  setActiveNtripProfileId,
  upsertNtripProfile,
  type NtripProfile,
} from './ntripProfiles';

const MAIN_SERVER_ID = 'gaga-main';

export interface DeviceSettingsPanelProps {
  onClose: () => void;
}

function buildMainServerUrl(serverUrl: string, token: string): string {
  const base = serverUrl.trim().replace(/\/+$/, '');
  const query = token.trim() ? `?key=${encodeURIComponent(token.trim())}` : '';
  return `${base}/gps${query}`;
}

// codigo de "configuracion rapida" - rellena servidor/token/NTRIP conocidos y activa el modo
// automatico de un golpe, para no tener que escribirlo a mano en cada tableta que se provisiona.
// El identificador del dispositivo NUNCA se llena solo a proposito (varia por tableta).
// codigo interno de "modo operador" - solo el equipo de desarrollo debe conocerlo. Un dispositivo
// nuevo llega en modo basico (login + panel normal, sin permisos extra); activar modo operador
// revela todo lo que hay debajo de este comentario y ya no se puede desactivar sin reinstalar la
// app. Viene de VITE_OPERATOR_MODE_CODE (.env de la raiz, ver seccion 5 de .env.example) - se
// compila DENTRO del bundle en build time, no es un secreto de servidor, solo evita que se vea a
// simple vista navegando el codigo fuente en GitHub (el repo es publico). '3009' es el valor de
// siempre si el .env no lo define.
const OPERATOR_MODE_CODE = import.meta.env.VITE_OPERATOR_MODE_CODE || '3009';

// id fijo para el perfil de servidor/NTRIP "de fabrica" - se usa tanto al activar Modo Operador
// por primera vez como desde el boton "Restaurar valores por defecto", asi repetir la accion
// actualiza el mismo perfil en vez de ir creando duplicados cada vez
const DEFAULT_PROFILE_ID = 'principal';

function envNtripVersion(value: string | undefined): NtripProfile['version'] {
  return value === 'v1' ? 'v1' : 'v2';
}

// valores NTRIP "de fabrica" que "Restaurar valores por defecto"/activar Modo Operador dejan
// listos - vienen de VITE_NTRIP_DEFAULT_* (.env de la raiz, ver seccion 5 de .env.example),
// nunca hardcodeados aqui: a diferencia de OPERATOR_MODE_CODE, esto SI son credenciales reales de
// una cuenta NTRIP, y este archivo se sube a un repo publico. Sin definirlos en el .env, cada
// campo cae a vacio - mismo criterio que el mount point, que ya se dejaba vacio a proposito para
// llenarse a mano por tableta/ubicacion.
const DEFAULT_NTRIP_VALUES = {
  name: import.meta.env.VITE_NTRIP_DEFAULT_NAME || 'Principal',
  host: import.meta.env.VITE_NTRIP_DEFAULT_HOST || '',
  port: Number(import.meta.env.VITE_NTRIP_DEFAULT_PORT) || 2101,
  username: import.meta.env.VITE_NTRIP_DEFAULT_USERNAME || '',
  password: import.meta.env.VITE_NTRIP_DEFAULT_PASSWORD || '',
  version: envNtripVersion(import.meta.env.VITE_NTRIP_DEFAULT_VERSION),
  mountpoint: import.meta.env.VITE_NTRIP_DEFAULT_MOUNTPOINT || '',
};

function formatLogTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}


const EMPTY_UPDATE_STATUS: AppUpdateStatus = {
  enabled: false,
  currentVersionCode: 0,
  currentVersionName: '',
  latestVersionCode: null,
  latestVersionName: null,
  checking: false,
  lastCheckAt: null,
  lastError: null,
};

const EMPTY_RTK_STATUS: RtkStatus = {
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
};

export function DeviceSettingsPanel({ onClose }: DeviceSettingsPanelProps) {
  const [unlocked, setUnlocked] = useState(!hasSettingsPassword());
  const [unlockInput, setUnlockInput] = useState('');
  const [unlockError, setUnlockError] = useState('');

  const [operatorMode, setOperatorMode] = useState(isOperatorModeEnabled());
  const [operatorModeCodeInput, setOperatorModeCodeInput] = useState('');
  const [operatorModeError, setOperatorModeError] = useState('');

  const [lockPasswordInput, setLockPasswordInput] = useState('');
  const [lockSavedMessage, setLockSavedMessage] = useState('');

  const [profiles, setProfiles] = useState<ServerProfile[]>([]);
  const [activeProfileId, setActiveProfileIdState] = useState(getActiveServerProfileId());
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [profileForm, setProfileForm] = useState<ServerProfile | null>(null);
  const [profileFormError, setProfileFormError] = useState('');
  const [profileMessage, setProfileMessage] = useState('');

  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? null;

  const [senderRunning, setSenderRunning] = useState(false);
  const [senderError, setSenderError] = useState<string | null>(null);
  const [bufferedCount, setBufferedCount] = useState(0);
  const [sendNowMessage, setSendNowMessage] = useState('');

  const [sendSettings, setSendSettings] = useState<TraccarSendSettings | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [logEntries, setLogEntries] = useState<TraccarLogEntry[]>([]);

  const [ntripProfiles, setNtripProfiles] = useState<NtripProfile[]>([]);
  const [ntripActiveProfileId, setNtripActiveProfileIdState] = useState(getActiveNtripProfileId());
  const [showNtripProfileModal, setShowNtripProfileModal] = useState(false);
  const [ntripProfileForm, setNtripProfileForm] = useState<NtripProfile | null>(null);
  const [ntripProfileFormError, setNtripProfileFormError] = useState('');
  const [ntripProfileMessage, setNtripProfileMessage] = useState('');

  const activeNtripProfile = ntripProfiles.find((p) => p.id === ntripActiveProfileId) ?? null;

  const [usbDevices, setUsbDevices] = useState<UsbDeviceInfo[]>([]);
  const [btDevices, setBtDevices] = useState<{ address: string; name: string | null }[]>([]);
  const [showUCenter, setShowUCenter] = useState(false);

  // mientras u-center esta abierto, el push rtkStatus (ya dispara hasta 10Hz) tambien trae
  // satelites/DOP/TTFF - fuera de u-center vuelve a apagarse solo (cleanup), sin poll extra ni
  // gasto de bateria de mas. .catch() silencioso: fuera de la app nativa esto simplemente no existe.
  useEffect(() => {
    if (!operatorMode) return;
    RtkNtrip.setDiagnosticsActive({ active: showUCenter }).catch(() => {});
    return () => {
      RtkNtrip.setDiagnosticsActive({ active: false }).catch(() => {});
    };
  }, [showUCenter, operatorMode]);

  const [baudRate, setBaudRateInput] = useState(460800);
  const [gnssBusy, setGnssBusy] = useState(false);
  const [rtkStatus, setRtkStatus] = useState<RtkStatus>(EMPTY_RTK_STATUS);

  const [mountpoints, setMountpoints] = useState<NtripMountpoint[]>([]);
  const [mountpointsLoading, setMountpointsLoading] = useState(false);
  const [mountpointsError, setMountpointsError] = useState('');

  const [kioskStatus, setKioskStatus] = useState<KioskStatus>({
    isDeviceOwner: false,
    enabled: false,
    active: false,
    developerOptionsEnabled: false,
    wasQrProvisioned: false,
    exactAlarmsGranted: false,
  });
  const [kioskBusy, setKioskBusy] = useState(false);
  const [kioskError, setKioskError] = useState('');
  const [mockLocationBusy, setMockLocationBusy] = useState(false);

  // true mientras la tableta se aprovisiona sola tras escanear el QR de fabrica (ver
  // SystemSection.tsx/KioskAdminReceiver.kt) - se salta el codigo de "Modo Operador" porque
  // escanear el QR ya fue la decision humana de dejar esta tableta como operador/kiosko. Corre UNA
  // sola vez al montar, independiente de operatorMode (Kiosk.getStatus() no pide ningun permiso,
  // a diferencia de TraccarSender/RtkNtrip - por eso puede llamarse antes de saber si esta tableta
  // ya es "modo operador").
  const [autoProvisioning, setAutoProvisioning] = useState(false);
  useEffect(() => {
    Kiosk.getStatus().then(async (status) => {
      setKioskStatus(status);
      if (!status.wasQrProvisioned || isOperatorModeEnabled()) return;
      setAutoProvisioning(true);
      try {
        enableOperatorMode();
        setOperatorMode(true);
        await applyDefaultProvisioning();
        await Kiosk.enable().catch(() => {});
        setKioskStatus(await Kiosk.getStatus());
      } finally {
        setAutoProvisioning(false);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>(EMPTY_UPDATE_STATUS);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState('');

  function refreshState() {
    TraccarSender.getState().then((s) => {
      setSenderRunning(s.running);
      setSenderError(s.lastError);
      setBufferedCount(s.bufferedCount);
    });
    TraccarSender.getLog().then((r) => setLogEntries(r.entries));
    // respaldo por si se pierde algun evento nativo "rtkStatus" - sin este poll, el data rate se
    // podia quedar pegado en el ultimo valor visto en vez de bajar a 0 cuando el flujo se detiene
    RtkNtrip.getStatus().then(setRtkStatus);
    AppUpdate.getStatus().then(setUpdateStatus);
    // solo lee Settings.Global (sin permisos, sin efectos secundarios) - se puede pollear libremente
    // para que "Opciones de desarrollador" se detecte sola al volver de Ajustes de Android
    Kiosk.getStatus().then(setKioskStatus);
  }

  useEffect(() => {
    if (!operatorMode) return;
    const existing = listServerProfiles();
    if (existing.length > 0) {
      setProfiles(existing);
      return;
    }
    // migracion de una sola vez: solo si el dispositivo YA tenia servidor/token/id guardados
    // sueltos de antes de que existieran los perfiles (getStoredApiBaseUrl es el valor crudo,
    // sin el fallback de produccion) - una instalacion nueva no debe ver nada precargado, se
    // queda vacia hasta que alguien use "Configuracion rapida" o cree una a mano
    const storedUrl = getStoredApiBaseUrl();
    const storedToken = getTelemetryToken();
    const storedDeviceId = getDeviceId();
    if (!storedUrl && !storedToken && !storedDeviceId) return;

    const seeded: ServerProfile = {
      id: crypto.randomUUID(),
      name: 'Principal',
      serverUrl: storedUrl,
      token: storedToken,
      deviceId: storedDeviceId,
    };
    upsertServerProfile(seeded);
    setActiveServerProfileId(seeded.id);
    setProfiles([seeded]);
    setActiveProfileIdState(seeded.id);
  }, [operatorMode]);

  useEffect(() => {
    if (!operatorMode) return;
    const existing = listNtripProfiles();
    if (existing.length > 0) {
      setNtripProfiles(existing);
      return;
    }
    // misma migracion de una sola vez que "Servidor e identidad" - solo si el dispositivo YA
    // tenia una config NTRIP guardada nativa de antes de que existieran los perfiles
    RtkNtrip.getNtripConfig().then((c) => {
      if (!c.host) return;
      const seeded: NtripProfile = {
        id: crypto.randomUUID(),
        name: 'Principal',
        host: c.host,
        port: c.port ?? 2101,
        mountpoint: c.mountpoint ?? '',
        username: c.username ?? '',
        password: c.password ?? '',
        version: c.version ?? 'v2',
      };
      upsertNtripProfile(seeded);
      setActiveNtripProfileId(seeded.id);
      setNtripProfiles([seeded]);
      setNtripActiveProfileIdState(seeded.id);
    });
  }, [operatorMode]);

  useEffect(() => {
    // en modo basico (sin activar) no se llama a ningun plugin nativo - ni una vez, ni en el
    // polling periodico de abajo - asi Android nunca pide permisos de ubicacion/USB de mas
    if (!operatorMode) return;

    TraccarSender.getSendSettings().then(setSendSettings);
    refreshState();
    Kiosk.getStatus().then(setKioskStatus);
    AppUpdate.getStatus().then(setUpdateStatus);
    RtkNtrip.getBaudRate().then((r) => setBaudRateInput(r.baudRate));
    RtkNtrip.listUsbDevices().then((r) => setUsbDevices(r.devices));
    RtkNtrip.listBluetoothDevices().then((r) => setBtDevices(r.devices));
    RtkNtrip.getStatus().then(setRtkStatus);

    // 'rtkStatus' dispara hasta 10 veces/seg (una por cada bloque de bytes) y NUNCA trae
    // satellites/pdop/hdop/vdop/dimension/ttffMs (solo viajan en getStatus(), ver
    // buildStatus(includeSatellites) en RtkNtripPlugin.kt) - reemplazar el estado completo con
    // cada push borraba esos campos milisegundos despues de que el poll de 1s los trajera. Se
    // conservan del estado previo cuando el push no los incluye.
    const rtkListenerPromise = RtkNtrip.addListener('rtkStatus', (status) =>
      setRtkStatus((prev) => ({
        ...status,
        satellites: status.satellites ?? prev.satellites,
        pdop: status.pdop ?? prev.pdop,
        hdop: status.hdop ?? prev.hdop,
        vdop: status.vdop ?? prev.vdop,
        dimension: status.dimension ?? prev.dimension,
        ttffMs: status.ttffMs ?? prev.ttffMs,
      })),
    );
    const usbListenerPromise = RtkNtrip.addListener('usbDevicesChanged', (data) => setUsbDevices(data.devices));
    const btListenerPromise = RtkNtrip.addListener('bluetoothDevicesChanged', (data) =>
      setBtDevices(data.devices),
    );
    // 1s (antes 4s) - bug real reportado: con el envio real pasando cada segundo, un poll de 4s
    // hacia que la bitacora de Ajustes mostrara "rafagas" de 3-4 entradas de golpe seguidas de
    // silencio, dando la impresion de que el envio era irregular cuando en realidad los timestamps
    // ya salian consecutivos - era la UI, no el envio real. Solo corre mientras Ajustes esta
    // abierto (clearInterval en el cleanup de abajo), no es un costo de bateria permanente.
    const interval = setInterval(refreshState, 1000);

    return () => {
      clearInterval(interval);
      rtkListenerPromise.then((h) => h.remove());
      usbListenerPromise.then((h) => h.remove());
      btListenerPromise.then((h) => h.remove());
    };
    // operatorMode: si se activa durante esta misma sesion (sin cerrar el panel), este efecto
    // debe correr una vez de verdad en ese momento, no solo al montar
  }, [operatorMode]);

  async function applyMainServer(mainUrl: string, mainToken: string) {
    const mainServer: TraccarServer = {
      id: MAIN_SERVER_ID,
      url: buildMainServerUrl(mainUrl, mainToken),
      enabled: true,
    };
    await TraccarSender.saveServers({ servers: [mainServer] });
  }

  // aplica una configuracion guardada como la "activa" - las claves en vivo que de verdad lee el
  // resto de la app (getApiBaseUrl/getTelemetryToken/getDeviceId, TraccarSender)
  async function applyProfile(profile: ServerProfile) {
    setApiBaseUrl(profile.serverUrl);
    setTelemetryToken(profile.token);
    setDeviceId(profile.deviceId);
    await TraccarSender.setDeviceId({ deviceId: profile.deviceId.trim() });
    await applyMainServer(profile.serverUrl, profile.token);
    setActiveServerProfileId(profile.id);
    setActiveProfileIdState(profile.id);
    // el actualizador nativo reusa el mismo servidor+token ya configurados aqui (el token YA es
    // el TELEMETRY_SHARED_SECRET, ver buildMainServerUrl) - nunca pisa el switch "enabled" actual
    await AppUpdate.configure({
      apiBaseUrl: profile.serverUrl.trim(),
      key: profile.token.trim(),
      enabled: updateStatus.enabled,
    }).catch(() => {});
  }

  async function selectProfile(id: string) {
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return;
    await applyProfile(profile);
    setProfileMessage('Aplicada');
    setTimeout(() => setProfileMessage(''), 2000);
  }

  function openCreateProfileModal() {
    setProfileForm({ id: crypto.randomUUID(), name: '', serverUrl: '', token: '', deviceId: '' });
    setProfileFormError('');
    setShowProfileModal(true);
  }

  function openEditProfileModal(profile: ServerProfile) {
    setProfileForm({ ...profile });
    setProfileFormError('');
    setShowProfileModal(true);
  }

  function closeProfileModal() {
    setShowProfileModal(false);
    setProfileForm(null);
    setProfileFormError('');
  }

  async function saveProfileModal() {
    if (!profileForm) return;
    if (!profileForm.name.trim() || !profileForm.serverUrl.trim()) {
      setProfileFormError('Nombre y servidor son obligatorios');
      return;
    }
    const isNew = !profiles.some((p) => p.id === profileForm.id);
    const saved: ServerProfile = { ...profileForm, name: profileForm.name.trim() };
    upsertServerProfile(saved);
    setProfiles(isNew ? [...profiles, saved] : profiles.map((p) => (p.id === saved.id ? saved : p)));
    // una configuracion nueva, o la que ya estaba activa, se aplica de inmediato - no tiene
    // sentido crear/editar una configuracion y que el dispositivo se quede mandando datos con otra
    if (isNew || saved.id === activeProfileId) await applyProfile(saved);
    closeProfileModal();
    setProfileMessage('Guardada');
    setTimeout(() => setProfileMessage(''), 2000);
  }

  function removeProfile(id: string) {
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return;
    if (!confirm(`Eliminar la configuracion "${profile.name}"?`)) return;
    deleteServerProfile(id);
    setProfiles(profiles.filter((p) => p.id !== id));
    if (activeProfileId === id) setActiveProfileIdState('');
  }

  async function toggleSender() {
    if (senderRunning) {
      await TraccarSender.stop();
      setSenderRunning(false);
      return;
    }
    try {
      await TraccarSender.start();
      setSenderRunning(true);
      setSenderError(null);
    } catch (e) {
      setSenderError(e instanceof Error ? e.message : 'No se pudo iniciar el envio');
    }
  }

  async function handleSendNow() {
    setSendNowMessage('Enviando...');
    try {
      const state = await TraccarSender.sendNow();
      setSenderError(state.lastError);
      setBufferedCount(state.bufferedCount);
      setSendNowMessage(state.lastError ? 'Fallo el envio' : 'Enviado');
      TraccarSender.getLog().then((r) => setLogEntries(r.entries));
    } catch (e) {
      setSendNowMessage(e instanceof Error ? e.message : 'No se pudo enviar');
    }
    setTimeout(() => setSendNowMessage(''), 2500);
  }

  function updateSendSettings(patch: Partial<TraccarSendSettings>) {
    setSendSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    TraccarSender.setSendSettings(patch);
  }

  async function refreshRtkStatus() {
    RtkNtrip.getStatus().then(setRtkStatus);
  }

  // el baud rate se persiste al cambiarlo, no solo al conectar - el auto-conectar al enchufar el
  // receptor (siempre activo, del lado nativo) corre sin pasar por esta pantalla en absoluto, asi
  // que necesita el valor ya guardado de antemano
  async function updateBaudRate(value: number) {
    setBaudRateInput(value);
    await RtkNtrip.setBaudRate({ baudRate: value });
  }

  async function grantBluetoothPermission() {
    await RtkNtrip.requestBluetoothPermission();
    const devices = await RtkNtrip.listBluetoothDevices();
    setBtDevices(devices.devices);
  }

  async function applyNtripConfig(profile: NtripProfile) {
    await RtkNtrip.setNtripConfig({
      host: profile.host,
      port: profile.port,
      mountpoint: profile.mountpoint,
      username: profile.username,
      password: profile.password,
      version: profile.version,
    });
  }

  async function selectNtripProfile(id: string) {
    const profile = ntripProfiles.find((p) => p.id === id);
    if (!profile) return;
    await applyNtripConfig(profile);
    setActiveNtripProfileId(profile.id);
    setNtripActiveProfileIdState(profile.id);
    setNtripProfileMessage('Aplicada');
    setTimeout(() => setNtripProfileMessage(''), 2000);
  }

  function openCreateNtripProfileModal() {
    setNtripProfileForm({ id: crypto.randomUUID(), name: '', host: '', port: 2101, mountpoint: '', username: '', password: '', version: 'v2' });
    setNtripProfileFormError('');
    setMountpoints([]);
    setMountpointsError('');
    setShowNtripProfileModal(true);
  }

  function openEditNtripProfileModal(profile: NtripProfile) {
    setNtripProfileForm({ ...profile });
    setNtripProfileFormError('');
    setMountpoints([]);
    setMountpointsError('');
    setShowNtripProfileModal(true);
  }

  function closeNtripProfileModal() {
    setShowNtripProfileModal(false);
    setNtripProfileForm(null);
    setNtripProfileFormError('');
  }

  async function saveNtripProfileModal() {
    if (!ntripProfileForm) return;
    if (!ntripProfileForm.name.trim() || !ntripProfileForm.host.trim() || !ntripProfileForm.mountpoint.trim()) {
      setNtripProfileFormError('Nombre, NTRIP address y mount point son obligatorios');
      return;
    }
    const isNew = !ntripProfiles.some((p) => p.id === ntripProfileForm.id);
    const saved: NtripProfile = { ...ntripProfileForm, name: ntripProfileForm.name.trim() };
    upsertNtripProfile(saved);
    setNtripProfiles(isNew ? [...ntripProfiles, saved] : ntripProfiles.map((p) => (p.id === saved.id ? saved : p)));
    if (isNew || saved.id === ntripActiveProfileId) {
      await applyNtripConfig(saved);
      setActiveNtripProfileId(saved.id);
      setNtripActiveProfileIdState(saved.id);
    }
    closeNtripProfileModal();
    setNtripProfileMessage('Guardada');
    setTimeout(() => setNtripProfileMessage(''), 2000);
  }

  function removeNtripProfile(id: string) {
    const profile = ntripProfiles.find((p) => p.id === id);
    if (!profile) return;
    if (!confirm(`Eliminar la configuracion NTRIP "${profile.name}"?`)) return;
    deleteNtripProfile(id);
    setNtripProfiles(ntripProfiles.filter((p) => p.id !== id));
    if (ntripActiveProfileId === id) setNtripActiveProfileIdState('');
  }

  async function searchNtripMountpoints() {
    if (!ntripProfileForm?.host) return;
    setMountpointsLoading(true);
    setMountpointsError('');
    try {
      const { mountpoints: found } = await RtkNtrip.fetchSourceTable({
        host: ntripProfileForm.host,
        port: ntripProfileForm.port ?? 2101,
      });
      setMountpoints(found);
      if (found.length === 0) setMountpointsError('El caster no reporto ningun punto de montura');
    } catch (e) {
      setMountpointsError(e instanceof Error ? e.message : 'No se pudo consultar el caster');
    }
    setMountpointsLoading(false);
  }

  // "Servicio GNSS" agrupa las 4 piezas (USB, NTRIP, ubicacion simulada, salida SW Maps) en un
  // solo control - cada pieza sigue siendo un plugin nativo independiente, esto solo orquesta
  // el orden de arranque/apagado desde el front. Salida SW Maps sin UI propia (sin uso real
  // confirmado por el equipo) - se sigue arrancando en el puerto fijo de siempre para no perder
  // la funcion nativa, solo se quito el control manual del panel de Ajustes.
  async function activateGnssService() {
    setGnssBusy(true);
    try {
      // el transporte (USB o Bluetooth, el que este disponible, USB con prioridad) se conecta solo
      // del lado nativo - ya no hace falta pedirle a esta funcion que "conecte" nada primero
      if (activeNtripProfile) await applyNtripConfig(activeNtripProfile);
      await RtkNtrip.startNtrip().catch(() => {});
      await RtkNtrip.startMockLocation().catch(() => {});
      await RtkNtrip.startSwMapsOutput({ port: 11123 }).catch(() => {});
    } finally {
      await refreshRtkStatus();
      setGnssBusy(false);
    }
  }

  async function deactivateGnssService() {
    setGnssBusy(true);
    try {
      await RtkNtrip.stopSwMapsOutput().catch(() => {});
      await RtkNtrip.stopMockLocation().catch(() => {});
      await RtkNtrip.stopNtrip().catch(() => {});
      await RtkNtrip.disconnectUsb().catch(() => {});
    } finally {
      await refreshRtkStatus();
      setGnssBusy(false);
    }
  }

  async function restartGnssService() {
    await deactivateGnssService();
    await activateGnssService();
  }

  // valores "de fabrica" completos - servidor de produccion (token/id vacios, varian por
  // tableta), envio continuo activado con intervalo 1s, NTRIP con DEFAULT_NTRIP_VALUES (todo
  // configurable via .env, ver arriba - mount point vacio si no se definio, se elige con "Buscar
  // puntos de montura"), baud rate 460800 y salida SW Maps activada en el puerto 11123. Se usa
  // tanto al activar Modo Operador por primera vez como desde "Restaurar valores por defecto"
  // (id fijo, no duplica)
  async function applyDefaultProvisioning() {
    const serverProfile: ServerProfile = {
      id: DEFAULT_PROFILE_ID,
      name: 'Principal',
      serverUrl: PRODUCTION_SERVER_URL,
      token: '',
      deviceId: '',
    };
    upsertServerProfile(serverProfile);
    await applyProfile(serverProfile);
    setProfiles(listServerProfiles());

    try {
      await TraccarSender.start();
      setSenderRunning(true);
      setSenderError(null);
    } catch (e) {
      setSenderError(e instanceof Error ? e.message : 'No se pudo iniciar el envio');
    }
    setSendSettings(await TraccarSender.resetSendSettings());

    const ntripProfile: NtripProfile = {
      id: DEFAULT_PROFILE_ID,
      name: DEFAULT_NTRIP_VALUES.name,
      host: DEFAULT_NTRIP_VALUES.host,
      port: DEFAULT_NTRIP_VALUES.port,
      mountpoint: DEFAULT_NTRIP_VALUES.mountpoint,
      username: DEFAULT_NTRIP_VALUES.username,
      password: DEFAULT_NTRIP_VALUES.password,
      version: DEFAULT_NTRIP_VALUES.version,
    };
    upsertNtripProfile(ntripProfile);
    setActiveNtripProfileId(ntripProfile.id);
    setNtripActiveProfileIdState(ntripProfile.id);
    setNtripProfiles(listNtripProfiles());

    await updateBaudRate(460800);
    await RtkNtrip.startSwMapsOutput({ port: 11123 }).catch(() => {});
    await refreshRtkStatus();
  }

  async function handleActivateOperatorMode() {
    if (operatorModeCodeInput.trim() !== OPERATOR_MODE_CODE) {
      setOperatorModeError('Codigo incorrecto');
      return;
    }
    const confirmed = confirm(
      'Esto activa el modo operador de forma permanente: la app va a pedir permisos de ' +
        'ubicacion y USB, y esta tableta podra empezar a mandar posicion al servidor. ' +
        'No se puede desactivar despues sin reinstalar la app.\n\n¿Continuar?',
    );
    if (!confirmed) return;
    enableOperatorMode();
    setOperatorMode(true);
    setOperatorModeCodeInput('');
    setOperatorModeError('');
    await applyDefaultProvisioning();
  }

  async function handleRestoreDefaults() {
    const confirmed = confirm(
      'Esto reemplaza la configuracion "Principal" de servidor y NTRIP con los valores de ' +
        'fabrica (servidor de produccion, token/identificador vacios, NTRIP sin mount point), ' +
        'reinicia el envio continuo y reactiva la salida SW Maps. No borra otras ' +
        'configuraciones guardadas.\n\n¿Continuar?',
    );
    if (!confirmed) return;
    await applyDefaultProvisioning();
  }

  async function toggleKiosk() {
    setKioskError('');
    if (kioskStatus.enabled) {
      const confirmed = confirm(
        'Esto apaga el Modo Kiosko: la tableta vuelve a mostrar la barra de estado y se puede ' +
          'salir de la app con el boton de inicio/recientes, como un dispositivo normal.\n\n¿Continuar?',
      );
      if (!confirmed) return;
      setKioskBusy(true);
      try {
        await Kiosk.disable();
        setKioskStatus(await Kiosk.getStatus());
      } finally {
        setKioskBusy(false);
      }
      return;
    }
    const confirmed = confirm(
      'Esto activa el Modo Kiosko: la tableta va a quedar bloqueada dentro de esta app - sin ' +
        'barra de estado, sin boton de inicio/recientes/encendido/volumen. Configura RTK y ' +
        '"Alarmas y recordatorios" antes de activar esto si todavia no lo hiciste - una vez ' +
        'activo, Lock Task Mode impide llegar a cualquier Ajuste de Android. Solo se puede salir ' +
        'desde aqui mismo (Ajustes), con la contrasena de ajustes.\n\n¿Continuar?',
    );
    if (!confirmed) return;
    setKioskBusy(true);
    try {
      await Kiosk.enable();
      setKioskStatus(await Kiosk.getStatus());
    } catch (e) {
      setKioskError(e instanceof Error ? e.message : 'No se pudo activar el Modo Kiosko');
    } finally {
      setKioskBusy(false);
    }
  }

  // ver KioskManager.releaseDeviceOwner (Kotlin) - unica forma confiable de desbloquear la
  // desinstalacion normal sin un reseteo de fabrica completo (adb dpm remove-active-admin y pm
  // clear confirmados bloqueados por el shell en builds de produccion, ver README)
  async function releaseDeviceOwner() {
    setKioskError('');
    const confirmed = confirm(
      'Esto libera a esta app como Device Owner. Deja de funcionar el Modo Kiosko y las ' +
        'actualizaciones automaticas silenciosas, y la app se vuelve desinstalable normal desde ' +
        'Ajustes de Android. Hay que volver a correr el comando adb de aprovisionamiento si se ' +
        'quiere recuperar esto despues.\n\n¿Continuar?',
    );
    if (!confirmed) return;
    setKioskBusy(true);
    try {
      await Kiosk.releaseDeviceOwner();
      setKioskStatus(await Kiosk.getStatus());
    } catch (e) {
      setKioskError(e instanceof Error ? e.message : 'No se pudo liberar Device Owner');
    } finally {
      setKioskBusy(false);
    }
  }

  // checklist de aprovisionamiento para RTK - "Opciones de desarrollador" y "ubicacion simulada"
  // son requisitos reales de Android que ninguna app puede activar sola (ver README). Solo se
  // reintenta mockLocation.start() cuando el usuario lo pide a proposito (este boton) - hacerlo
  // solo/automatico en un poll de fondo registraria un GPS_PROVIDER de prueba sin datos en
  // cualquier tableta (use RTK o no), rompiendole el GPS real sin que nadie lo pidiera.
  async function openDeveloperOptionsSettings() {
    await Kiosk.openDeveloperOptions().catch(() => {});
  }

  // bug real confirmado en hardware: Device Owner NO recibe SCHEDULE_EXACT_ALARM otorgado solo
  // (contrario a lo que se asumia antes) - sin esto, la suspension por perdida de corriente tarda
  // varios segundos/minutos mas de lo configurado. refreshState() (poll cada 4s) ya recoge el
  // cambio solo despues de concederlo en Ajustes, no hace falta un boton de "verificar" aparte.
  async function openExactAlarmSettings() {
    await Kiosk.openExactAlarmSettings().catch(() => {});
  }

  async function retryMockLocationCheck() {
    setMockLocationBusy(true);
    try {
      await RtkNtrip.startMockLocation().catch(() => {});
      setRtkStatus(await RtkNtrip.getStatus());
    } finally {
      setMockLocationBusy(false);
    }
  }

  async function toggleAppUpdate() {
    setUpdateError('');
    const nextEnabled = !updateStatus.enabled;
    if (nextEnabled) {
      const confirmed = confirm(
        'Esto activa la actualizacion automatica: la tableta va a revisar periodicamente si hay ' +
          'una version nueva de la app en el servidor y, si la hay, la descarga, verifica su ' +
          'integridad y la instala sola, sin ningun aviso ni confirmacion en pantalla.\n\n¿Continuar?',
      );
      if (!confirmed) return;
    }
    setUpdateBusy(true);
    try {
      await AppUpdate.configure({
        apiBaseUrl: (activeProfile?.serverUrl ?? getStoredApiBaseUrl()).trim(),
        key: (activeProfile?.token ?? getTelemetryToken()).trim(),
        enabled: nextEnabled,
      });
      setUpdateStatus(await AppUpdate.getStatus());
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : 'No se pudo cambiar la actualizacion automatica');
    } finally {
      setUpdateBusy(false);
    }
  }

  async function checkForUpdateNow() {
    setUpdateError('');
    setUpdateBusy(true);
    try {
      await AppUpdate.checkNow();
      setUpdateStatus(await AppUpdate.getStatus());
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : 'No se pudo revisar actualizaciones');
    } finally {
      setUpdateBusy(false);
    }
  }

  function handleUnlock() {
    if (unlockInput.trim() === getSettingsPassword()) {
      setUnlocked(true);
      setUnlockError('');
      setUnlockInput('');
    } else {
      setUnlockError('Contrasena incorrecta');
    }
  }

  function handleSetLockPassword() {
    setSettingsPassword(lockPasswordInput);
    setLockPasswordInput('');
    setLockSavedMessage(lockPasswordInput.trim() ? 'Ajustes bloqueados' : 'Bloqueo quitado');
    setTimeout(() => setLockSavedMessage(''), 2500);
  }

  if (!unlocked) {
    return (
      <div className="ds-overlay">
        <div className="ds-card">
          <button className="ds-close" onClick={onClose} aria-label="Cerrar" title="Cerrar">
            X
          </button>
          <h2>Ajustes bloqueados</h2>
          <p className="ds-hint">Esta tableta tiene los ajustes protegidos - pide la contrasena al encargado.</p>
          <input
            type="password"
            placeholder="Contrasena"
            value={unlockInput}
            onChange={(e) => setUnlockInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
          />
          <div className="ds-actions">
            <button onClick={handleUnlock}>Desbloquear</button>
          </div>
          {unlockError && <div className="ds-error-block">{unlockError}</div>}
        </div>
      </div>
    );
  }

  if (autoProvisioning) {
    return (
      <div className="ds-overlay">
        <div className="ds-card">
          <h2>Configurando tableta…</h2>
          <p className="ds-hint">Configurando servidor, NTRIP y envío de posición - no cierres la app.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ds-overlay">
      <div className="ds-card">
        <button className="ds-close" onClick={onClose} aria-label="Cerrar" title="Cerrar">
          X
        </button>
        <h2>Configuracion del dispositivo</h2>

        {operatorMode ? (
          <>
        <p className="ds-hint">Modo operador: Activado - no se puede desactivar sin reinstalar la app.</p>

        <section className="ds-section">
          <h3>Servidor e identidad</h3>
          <div className="ds-actions">
            <button onClick={openCreateProfileModal}>+ Nueva configuracion</button>
            {profileMessage && <span className="ds-saved">{profileMessage}</span>}
          </div>

          {profiles.length === 0 && (
            <p className="ds-hint">Sin configuraciones guardadas todavia - agrega una para poder enviar posicion.</p>
          )}
          <div className="ds-profile-list">
            {profiles.map((p) => {
              const isActive = p.id === activeProfileId;
              return (
                <div className={`ds-profile-card${isActive ? ' ds-profile-active' : ''}`} key={p.id}>
                  <button className="ds-profile-select" onClick={() => selectProfile(p.id)}>
                    <span className="ds-profile-top">
                      <span className="ds-profile-name">{p.name}</span>
                      {isActive && <span className="ds-profile-badge">Activa</span>}
                    </span>
                    <span className="ds-profile-summary">{p.serverUrl || '(sin servidor)'}</span>
                    <span className="ds-profile-summary">ID: {p.deviceId || '(sin identificador)'}</span>
                  </button>
                  <div className="ds-profile-actions">
                    <button onClick={() => openEditProfileModal(p)}>Editar</button>
                    <button className="ds-remove" onClick={() => removeProfile(p.id)}>
                      Eliminar
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <p className="ds-hint">
            {activeProfile
              ? `El envio de posicion manda a ${buildMainServerUrl(activeProfile.serverUrl, activeProfile.token)}`
              : 'Sin configuracion activa - elige o crea una para poder enviar posicion.'}
          </p>

          <div className="ds-actions">
            <button onClick={handleSendNow}>Enviar ubicacion ahora</button>
            {sendNowMessage && <span className="ds-saved">{sendNowMessage}</span>}
          </div>

          <div className="ds-switch-row">
            <label className="ds-switch">
              <input type="checkbox" checked={senderRunning} onChange={toggleSender} />
              <span className="ds-switch-track" />
            </label>
            <span className="ds-switch-label">Envio continuo</span>
            <span className="ds-switch-spacer" />
            {sendSettings && (
              <div className="ds-inline-field">
                <label className="ds-label">Intervalo (s)</label>
                <input
                  type="number"
                  min={1}
                  value={sendSettings.intervalSeconds}
                  onChange={(e) => updateSendSettings({ intervalSeconds: Number(e.target.value) })}
                />
              </div>
            )}
          </div>
          <div className="ds-actions">
            <span className="ds-status">
              {senderRunning ? 'Enviando' : 'Detenido'}
              {bufferedCount > 0 && ` - ${bufferedCount} en buffer sin conexion`}
              {senderError && <span className="ds-error"> - {senderError}</span>}
            </span>
          </div>

          <button className="ds-add" onClick={() => setShowLog((v) => !v)}>
            {showLog ? 'Ocultar bitacora' : 'Mostrar bitacora de envios'}
          </button>
          {showLog && (
            <div className="ds-log">
              {logEntries.length === 0 && <div className="ds-log-empty">Sin envios registrados todavia</div>}
              {logEntries.map((entry, i) => (
                <div className={`ds-log-row ${entry.success ? 'ds-log-ok' : 'ds-log-fail'}`} key={i}>
                  <span className="ds-log-time">{formatLogTime(entry.timestamp)}</span>
                  <span className="ds-log-server">{entry.serverUrl}</span>
                  <span className="ds-log-message">{entry.message}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {showProfileModal && profileForm && (
          <div className="ds-modal-overlay" onClick={closeProfileModal}>
            <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
              <h3>{profiles.some((p) => p.id === profileForm.id) ? 'Editar configuracion' : 'Nueva configuracion'}</h3>
              <label className="ds-label">Nombre</label>
              <input
                placeholder="Ej. Servidor de pruebas"
                value={profileForm.name}
                onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })}
              />
              <label className="ds-label">Servidor GAGA GPS</label>
              <input
                placeholder="http://192.168.1.50:3001"
                value={profileForm.serverUrl}
                onChange={(e) => setProfileForm({ ...profileForm, serverUrl: e.target.value })}
              />
              <label className="ds-label">Token de telemetria</label>
              <input
                placeholder="TELEMETRY_SHARED_SECRET del servidor"
                value={profileForm.token}
                onChange={(e) => setProfileForm({ ...profileForm, token: e.target.value })}
              />
              <label className="ds-label">Identificador del dispositivo</label>
              <input
                placeholder="Igual que en Traccar Client"
                value={profileForm.deviceId}
                onChange={(e) => setProfileForm({ ...profileForm, deviceId: e.target.value })}
              />
              {profileFormError && <div className="ds-error-block">{profileFormError}</div>}
              <div className="ds-actions">
                <button onClick={saveProfileModal}>Guardar</button>
                <button className="ds-remove" onClick={closeProfileModal}>
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}

        <section className="ds-section">
          <h3>Receptor RTK y correccion NTRIP</h3>
          <p className="ds-hint">Todo lo del receptor y las correcciones vive en u-center.</p>
          <div className="ds-actions">
            <button onClick={() => setShowUCenter(true)}>u-center</button>
          </div>
          {showUCenter && (
            <UCenterView
              status={rtkStatus}
              onClose={() => setShowUCenter(false)}
              connection={{
                kioskStatus,
                mockLocationBusy,
                onOpenDeveloperOptions: openDeveloperOptionsSettings,
                onRetryMockLocation: retryMockLocationCheck,
                btDevices,
                onGrantBluetoothPermission: grantBluetoothPermission,
                usbDevices,
                baudRate,
                onUpdateBaudRate: updateBaudRate,
              }}
              ntrip={{
                profiles: ntripProfiles,
                activeProfileId: ntripActiveProfileId,
                activeProfile: activeNtripProfile,
                message: ntripProfileMessage,
                onCreate: openCreateNtripProfileModal,
                onSelect: selectNtripProfile,
                onEdit: openEditNtripProfileModal,
                onRemove: removeNtripProfile,
                showModal: showNtripProfileModal,
                form: ntripProfileForm,
                onFormChange: setNtripProfileForm,
                onSearchMountpoints: searchNtripMountpoints,
                mountpointsLoading,
                mountpointsError,
                mountpoints,
                formError: ntripProfileFormError,
                onSave: saveNtripProfileModal,
                onCloseModal: closeNtripProfileModal,
              }}
            />
          )}
        </section>

        <section className="ds-section">
          <h3>Salidas</h3>
          <label className="ds-toggle-row">
            <input type="checkbox" checked={rtkStatus.mockLocationActive} disabled readOnly />
            Ubicacion simulada (mock location)
          </label>
        </section>

        <section className="ds-section">
          <h3>Bloqueo de ajustes</h3>
          <p className="ds-hint">
            {hasSettingsPassword()
              ? 'Los ajustes estan protegidos con contrasena.'
              : 'Sin contrasena - cualquiera puede abrir y cambiar los ajustes.'}
          </p>
          <input
            type="password"
            placeholder="Nueva contrasena (vacio = quitar bloqueo)"
            value={lockPasswordInput}
            onChange={(e) => setLockPasswordInput(e.target.value)}
          />
          <div className="ds-actions">
            <button onClick={handleSetLockPassword}>
              {hasSettingsPassword() ? 'Cambiar / quitar contrasena' : 'Bloquear con contrasena'}
            </button>
            {lockSavedMessage && <span className="ds-saved">{lockSavedMessage}</span>}
          </div>
        </section>

        <section className="ds-section">
          <h3>Modo Kiosko</h3>
          <p className="ds-hint">
            {kioskStatus.isDeviceOwner
              ? 'Tableta aprovisionada (Device Owner) - Modo Kiosko disponible.'
              : 'Tableta sin aprovisionar - hace falta el comando adb (o QR) antes de activar el Modo Kiosko.'}
          </p>
          {!hasSettingsPassword() && (
            <p className="ds-hint">Ponle contrasena en "Bloqueo de ajustes" antes de activar el kiosko.</p>
          )}
          <div className="ds-switch-row">
            <label className="ds-switch">
              <input
                type="checkbox"
                checked={kioskStatus.enabled}
                onChange={toggleKiosk}
                disabled={kioskBusy || (!kioskStatus.enabled && !kioskStatus.isDeviceOwner)}
              />
              <span className="ds-switch-track" />
            </label>
            <span className="ds-switch-label">
              Modo Kiosko {kioskStatus.active ? '(activo ahora mismo)' : kioskStatus.enabled ? '(se activa al reabrir la app)' : ''}
            </span>
          </div>
          {kioskError && <div className="ds-error-block">{kioskError}</div>}
          <p className="ds-hint">
            Bloquea la tableta dentro de la app. Para salir: vuelve aqui con la contrasena y apaga
            el switch.
          </p>
          {!kioskStatus.exactAlarmsGranted && (
            <div className="ds-hint" style={{ border: '1px solid #d29922', borderRadius: 6, padding: 10 }}>
              <p>
                <strong>Pendiente:</strong> falta conceder "Alarmas y recordatorios" - sin esto, la
                suspension por perdida de corriente y la actualizacion automatica pueden tardar
                varios segundos/minutos mas de lo configurado.
              </p>
              <div className="ds-actions">
                <button onClick={openExactAlarmSettings}>Abrir Ajustes de Android</button>
              </div>
            </div>
          )}
          {kioskStatus.isDeviceOwner && (
            <div className="ds-actions" style={{ marginTop: 10 }}>
              <button onClick={releaseDeviceOwner} disabled={kioskBusy}>
                Liberar Device Owner (para desinstalar)
              </button>
              <p className="ds-hint">
                Solo si necesitas desinstalar la app - hay que reaprovisionar con adb para
                recuperar Kiosko/actualizaciones despues.
              </p>
            </div>
          )}
        </section>

        <section className="ds-section">
          <h3>Actualizacion automatica</h3>
          <p className="ds-hint">
            Version instalada: {updateStatus.currentVersionName || '?'} (build {updateStatus.currentVersionCode || '?'})
            {updateStatus.latestVersionCode !== null && (
              <>
                {' '}- ultima publicada: {updateStatus.latestVersionName} (build {updateStatus.latestVersionCode})
              </>
            )}
          </p>
          <div className="ds-switch-row">
            <label className="ds-switch">
              <input
                type="checkbox"
                checked={updateStatus.enabled}
                onChange={toggleAppUpdate}
                disabled={updateBusy}
              />
              <span className="ds-switch-track" />
            </label>
            <span className="ds-switch-label">
              Actualizacion automatica {updateStatus.checking ? '(revisando ahora)' : ''}
            </span>
          </div>
          <div className="ds-actions">
            <button onClick={checkForUpdateNow} disabled={updateBusy}>
              Buscar actualizacion ahora
            </button>
          </div>
          {updateStatus.lastCheckAt && (
            <p className="ds-hint">Ultima revision: {new Date(updateStatus.lastCheckAt).toLocaleString()}</p>
          )}
          {(updateError || updateStatus.lastError) && (
            <div className="ds-error-block">{updateError || updateStatus.lastError}</div>
          )}
          <p className="ds-hint">Revisa el servidor y se actualiza sola, sin avisos en pantalla.</p>
        </section>

        <section className="ds-section">
          <h3>Servicio GNSS</h3>
          <div className="ds-actions">
            <button onClick={restartGnssService} disabled={gnssBusy}>
              Reiniciar
            </button>
          </div>
          <p className="ds-hint">Reinicia USB + NTRIP + ubicacion simulada juntos - util si algo quedo en mal estado.</p>
          <div className="ds-actions">
            <button className="ds-remove" onClick={handleRestoreDefaults}>
              Restaurar valores por defecto
            </button>
          </div>
          <p className="ds-hint">Regresa servidor, NTRIP y envio a los valores de fabrica.</p>
        </section>
          </>
        ) : (
          <section className="ds-section">
            <h3>Modo operador</h3>
            <p className="ds-hint">Modo basico - sin envio de datos. Activa el modo operador con el codigo del equipo.</p>
            <input
              placeholder="Codigo de 4 digitos"
              value={operatorModeCodeInput}
              onChange={(e) => setOperatorModeCodeInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleActivateOperatorMode()}
            />
            <div className="ds-actions">
              <button onClick={handleActivateOperatorMode}>Activar modo operador</button>
            </div>
            {operatorModeError && <div className="ds-error-block">{operatorModeError}</div>}
          </section>
        )}
      </div>
    </div>
  );
}
