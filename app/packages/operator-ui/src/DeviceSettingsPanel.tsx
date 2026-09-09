import {
  RtkNtrip,
  TraccarSender,
  type NtripMountpoint,
  type RtkFixLabel,
  type RtkStatus,
  type TraccarLogEntry,
  type TraccarSendSettings,
  type TraccarServer,
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
// El identificador del dispositivo y el mount point NUNCA se llenan solos a proposito (varian por
// tableta/ubicacion). Para cambiar este codigo, solo pide que se edite aqui.
// codigo interno de "modo operador" - solo el equipo de desarrollo debe conocerlo. Un dispositivo
// nuevo llega en modo basico (login + panel normal, sin permisos extra); activar modo operador
// revela todo lo que hay debajo de este comentario y ya no se puede desactivar sin reinstalar la
// app. Cambiar el codigo aqui si hace falta.
const OPERATOR_MODE_CODE = '3009';

// id fijo para el perfil de servidor/NTRIP "de fabrica" - se usa tanto al activar Modo Operador
// por primera vez como desde el boton "Restaurar valores por defecto", asi repetir la accion
// actualiza el mismo perfil en vez de ir creando duplicados cada vez
const DEFAULT_PROFILE_ID = 'principal';

// valores NTRIP conocidos que "Restaurar valores por defecto"/activar Modo Operador dejan listos
// de fabrica (ver applyDefaultProvisioning) - el mount point se queda vacio a proposito, varia por
// tableta/ubicacion, se elige con "Buscar puntos de montura"
const DEFAULT_NTRIP_VALUES = {
  host: 'ntrip.earthscope.org',
  port: 2101,
  username: 'nervous_raman',
  password: 'Lh4lI10A0brg43QO',
  version: 'v2' as const,
};

function formatLogTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
  return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
}

function formatTotalBytes(totalBytes: number): string {
  if (totalBytes < 1024) return `${totalBytes} B`;
  if (totalBytes < 1024 * 1024) return `${(totalBytes / 1024).toFixed(1)} KB`;
  return `${(totalBytes / (1024 * 1024)).toFixed(2)} MB`;
}

function fixBadgeColor(label: RtkFixLabel): string {
  switch (label) {
    case 'RTK_FIX':
      return '#3fb950';
    case 'RTK_FLOAT':
      return '#f0a83c';
    case 'DGPS':
    case 'GPS':
      return '#4f8ff0';
    default:
      return '#565d68';
  }
}

function fixBadgeLabel(label: RtkFixLabel): string {
  switch (label) {
    case 'RTK_FIX':
      return 'RTK FIJO';
    case 'RTK_FLOAT':
      return 'RTK FLOTANTE';
    case 'DGPS':
      return 'DGPS';
    case 'GPS':
      return 'GPS';
    default:
      return 'SIN FIX - buscando satelites';
  }
}

const EMPTY_RTK_STATUS: RtkStatus = {
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

  const [usbDevices, setUsbDevices] = useState<{ deviceId: number; name: string | null }[]>([]);
  const [selectedUsbDeviceId, setSelectedUsbDeviceId] = useState<number | null>(null);
  const [baudRate, setBaudRateInput] = useState(460800);
  const [swMapsPortInput, setSwMapsPortInput] = useState(11123);
  const [gnssBusy, setGnssBusy] = useState(false);
  const [rtkStatus, setRtkStatus] = useState<RtkStatus>(EMPTY_RTK_STATUS);
  const [mountpoints, setMountpoints] = useState<NtripMountpoint[]>([]);
  const [mountpointsLoading, setMountpointsLoading] = useState(false);
  const [mountpointsError, setMountpointsError] = useState('');

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
    RtkNtrip.getBaudRate().then((r) => setBaudRateInput(r.baudRate));
    RtkNtrip.listUsbDevices().then((r) => setUsbDevices(r.devices));
    RtkNtrip.getStatus().then((s) => {
      setRtkStatus(s);
      setSwMapsPortInput(s.swMapsPort);
    });

    const rtkListenerPromise = RtkNtrip.addListener('rtkStatus', (status) => setRtkStatus(status));
    const usbListenerPromise = RtkNtrip.addListener('usbDevicesChanged', (data) => setUsbDevices(data.devices));
    const interval = setInterval(refreshState, 4000);

    return () => {
      clearInterval(interval);
      rtkListenerPromise.then((h) => h.remove());
      usbListenerPromise.then((h) => h.remove());
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
    await TraccarSender.setDeviceId({ deviceId: profile.deviceId.trim() || 'GAGA-DEVICE' });
    await applyMainServer(profile.serverUrl, profile.token);
    setActiveServerProfileId(profile.id);
    setActiveProfileIdState(profile.id);
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
  // receptor (siempre activo, del lado nativo) corre sin pasar por connectUsb(), asi que necesita
  // el valor ya guardado de antemano
  async function updateBaudRate(value: number) {
    setBaudRateInput(value);
    await RtkNtrip.setBaudRate({ baudRate: value });
  }

  async function connectUsb() {
    if (selectedUsbDeviceId == null) return;
    await RtkNtrip.connectUsb({ deviceId: selectedUsbDeviceId, baudRate });
  }

  async function toggleUsbConnection() {
    if (rtkStatus.usbConnected) {
      await RtkNtrip.disconnectUsb();
      return;
    }
    await connectUsb();
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

  async function toggleNtrip() {
    if (rtkStatus.ntripConnected) {
      await RtkNtrip.stopNtrip();
      return;
    }
    if (!activeNtripProfile) return;
    await applyNtripConfig(activeNtripProfile);
    await RtkNtrip.startNtrip();
  }

  async function toggleMockLocation() {
    try {
      if (rtkStatus.mockLocationActive) {
        await RtkNtrip.stopMockLocation();
      } else {
        await RtkNtrip.startMockLocation();
      }
      refreshRtkStatus();
    } catch (e) {
      setRtkStatus((prev) => ({
        ...prev,
        ntripError: e instanceof Error ? e.message : 'No se pudo cambiar la ubicacion simulada',
      }));
    }
  }

  async function toggleSwMapsOutput() {
    if (rtkStatus.swMapsOutputRunning) {
      await RtkNtrip.stopSwMapsOutput();
    } else {
      await RtkNtrip.startSwMapsOutput({ port: swMapsPortInput });
    }
    refreshRtkStatus();
  }

  // "Servicio GNSS" agrupa las 4 piezas (USB, NTRIP, ubicacion simulada, salida SW Maps) en un
  // solo control - cada pieza sigue siendo un plugin nativo independiente, esto solo orquesta
  // el orden de arranque/apagado desde el front
  async function activateGnssService() {
    setGnssBusy(true);
    try {
      if (selectedUsbDeviceId != null && !rtkStatus.usbConnected) {
        await connectUsb();
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      if (activeNtripProfile) await applyNtripConfig(activeNtripProfile);
      await RtkNtrip.startNtrip().catch(() => {});
      await RtkNtrip.startMockLocation().catch(() => {});
      await RtkNtrip.startSwMapsOutput({ port: swMapsPortInput }).catch(() => {});
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
  // tableta), envio continuo activado con intervalo 1s, NTRIP con DEFAULT_NTRIP_VALUES (mount
  // point vacio, se elige con "Buscar puntos de montura"), baud rate 460800 y salida SW Maps
  // activada en el puerto 11123. Se usa tanto al activar Modo Operador por primera vez como
  // desde "Restaurar valores por defecto" (id fijo, no duplica)
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
      name: 'Principal',
      host: DEFAULT_NTRIP_VALUES.host,
      port: DEFAULT_NTRIP_VALUES.port,
      mountpoint: '',
      username: DEFAULT_NTRIP_VALUES.username,
      password: DEFAULT_NTRIP_VALUES.password,
      version: DEFAULT_NTRIP_VALUES.version,
    };
    upsertNtripProfile(ntripProfile);
    setActiveNtripProfileId(ntripProfile.id);
    setNtripActiveProfileIdState(ntripProfile.id);
    setNtripProfiles(listNtripProfiles());

    await updateBaudRate(460800);
    setSwMapsPortInput(11123);
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
          <p className="ds-hint">
            Modo de correccion: NTRIP Client (unico disponible - PointPerfect y USB Serial vendran despues).
          </p>

          <div className="ds-actions">
            <button onClick={openCreateNtripProfileModal}>+ Nueva configuracion NTRIP</button>
            {ntripProfileMessage && <span className="ds-saved">{ntripProfileMessage}</span>}
          </div>

          {ntripProfiles.length === 0 && (
            <p className="ds-hint">Sin configuraciones NTRIP guardadas todavia.</p>
          )}
          <div className="ds-profile-list">
            {ntripProfiles.map((p) => {
              const isActive = p.id === ntripActiveProfileId;
              return (
                <div className={`ds-profile-card${isActive ? ' ds-profile-active' : ''}`} key={p.id}>
                  <button className="ds-profile-select" onClick={() => selectNtripProfile(p.id)}>
                    <span className="ds-profile-top">
                      <span className="ds-profile-name">{p.name}</span>
                      {isActive && <span className="ds-profile-badge">Activa</span>}
                    </span>
                    <span className="ds-profile-summary">
                      {p.host || '(sin servidor)'}:{p.port}
                    </span>
                    <span className="ds-profile-summary">Mount point: {p.mountpoint || '(sin elegir)'}</span>
                  </button>
                  <div className="ds-profile-actions">
                    <button onClick={() => openEditNtripProfileModal(p)}>Editar</button>
                    <button className="ds-remove" onClick={() => removeNtripProfile(p.id)}>
                      Eliminar
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="ds-actions">
            <button onClick={toggleNtrip} disabled={!activeNtripProfile}>
              {rtkStatus.ntripConnected ? 'Detener NTRIP' : 'Conectar NTRIP'}
            </button>
            <span className="ds-status">
              {rtkStatus.ntripConnected
                ? `Conectado - ${formatRate(rtkStatus.ntripDataRateBps)} - ${formatTotalBytes(rtkStatus.ntripTotalBytes)} total`
                : 'Sin conectar'}
            </span>
          </div>
          {rtkStatus.ntripError && <div className="ds-error-block">{rtkStatus.ntripError}</div>}

          <h4 className="ds-subheading">Receptor RTK (USB)</h4>
          <div className="ds-actions">
            <span className="ds-status">
              {rtkStatus.usbConnected
                ? `Conectado - ${rtkStatus.connectedUsbDeviceName ?? 'USB'} - ${formatRate(rtkStatus.usbDataRateBps)} - ${formatTotalBytes(rtkStatus.usbTotalBytes)} total`
                : 'Sin conectar'}
            </span>
          </div>
          {usbDevices.map((d) => {
            // "seleccionado" no depende solo del clic manual (selectedUsbDeviceId) - el receptor
            // se auto-conecta solo al enchufarlo, sin que nadie haga clic en la lista, asi que
            // tambien cuenta como seleccionada la fila que coincide con el dispositivo YA conectado
            const isSelected =
              selectedUsbDeviceId === d.deviceId ||
              (rtkStatus.usbConnected && rtkStatus.connectedUsbDeviceId === d.deviceId);
            return (
              <label className="ds-usb-option" key={d.deviceId}>
                <input
                  type="radio"
                  name="usbDevice"
                  checked={isSelected}
                  onChange={() => setSelectedUsbDeviceId(d.deviceId)}
                />
                {d.name ?? `USB ${d.deviceId}`}
              </label>
            );
          })}
          {usbDevices.length === 0 && <p className="ds-hint">Ningun dispositivo USB detectado todavia.</p>}
          <label className="ds-label">Baud rate</label>
          <input type="number" value={baudRate} onChange={(e) => updateBaudRate(Number(e.target.value))} />
          <div className="ds-actions">
            <button onClick={toggleUsbConnection} disabled={!rtkStatus.usbConnected && selectedUsbDeviceId == null}>
              {rtkStatus.usbConnected ? 'Desconectar' : 'Conectar'}
            </button>
          </div>
          <p className="ds-hint">
            El receptor se conecta solo al enchufarlo - siempre, sin excepcion, sin pedir
            confirmacion. Al conectar arranca tambien NTRIP (con la configuracion activa de
            arriba, si ya tiene mount point) y la ubicacion simulada; al desconectarlo, todo se
            apaga solo y la tableta vuelve a su GPS normal.
          </p>
        </section>

        {showNtripProfileModal && ntripProfileForm && (
          <div className="ds-modal-overlay" onClick={closeNtripProfileModal}>
            <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
              <h3>
                {ntripProfiles.some((p) => p.id === ntripProfileForm.id)
                  ? 'Editar configuracion NTRIP'
                  : 'Nueva configuracion NTRIP'}
              </h3>
              <label className="ds-label">Nombre</label>
              <input
                placeholder="Ej. Caster EarthScope"
                value={ntripProfileForm.name}
                onChange={(e) => setNtripProfileForm({ ...ntripProfileForm, name: e.target.value })}
              />
              <div className="ds-row">
                <input
                  placeholder="NTRIP address"
                  value={ntripProfileForm.host}
                  onChange={(e) => setNtripProfileForm({ ...ntripProfileForm, host: e.target.value })}
                />
                <input
                  placeholder="Puerto"
                  type="number"
                  value={ntripProfileForm.port}
                  onChange={(e) => setNtripProfileForm({ ...ntripProfileForm, port: Number(e.target.value) })}
                />
              </div>
              <div className="ds-row">
                <input
                  placeholder="Mount point"
                  value={ntripProfileForm.mountpoint}
                  onChange={(e) => setNtripProfileForm({ ...ntripProfileForm, mountpoint: e.target.value })}
                />
                <button onClick={searchNtripMountpoints} disabled={!ntripProfileForm.host || mountpointsLoading}>
                  {mountpointsLoading ? 'Buscando...' : 'Buscar puntos de montura'}
                </button>
              </div>
              {mountpointsError && <div className="ds-error-block">{mountpointsError}</div>}
              {mountpoints.length > 0 && (
                <select
                  value=""
                  onChange={(e) => setNtripProfileForm({ ...ntripProfileForm, mountpoint: e.target.value })}
                >
                  <option value="" disabled>
                    {mountpoints.length} puntos de montura disponibles - elige uno
                  </option>
                  {mountpoints.map((m) => (
                    <option key={m.mountpoint} value={m.mountpoint}>
                      {m.mountpoint} - {m.identifier || m.format} ({m.country}){m.nmeaRequired ? ' - pide GGA' : ''}
                    </option>
                  ))}
                </select>
              )}
              <div className="ds-row">
                <input
                  placeholder="Usuario"
                  value={ntripProfileForm.username}
                  onChange={(e) => setNtripProfileForm({ ...ntripProfileForm, username: e.target.value })}
                />
                <input
                  placeholder="Contrasena"
                  type="password"
                  value={ntripProfileForm.password}
                  onChange={(e) => setNtripProfileForm({ ...ntripProfileForm, password: e.target.value })}
                />
              </div>
              <label className="ds-label">Version NTRIP</label>
              <select
                value={ntripProfileForm.version}
                onChange={(e) =>
                  setNtripProfileForm({ ...ntripProfileForm, version: e.target.value as NtripProfile['version'] })
                }
              >
                <option value="v1">V1</option>
                <option value="v2">V2</option>
              </select>
              <p className="ds-hint">
                V2 (default) usa el protocolo NTRIP moderno sobre HTTP/1.1 - funciona con la
                mayoria de casters actuales, incluido EarthScope. V1 manda el formato minimo
                original sin esos headers - usalo solo si el proveedor del caster pide
                compatibilidad antigua.
              </p>
              {ntripProfileFormError && <div className="ds-error-block">{ntripProfileFormError}</div>}
              <div className="ds-actions">
                <button onClick={saveNtripProfileModal}>Guardar</button>
                <button className="ds-remove" onClick={closeNtripProfileModal}>
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}

        <section className="ds-section">
          <h3>Estado del fix GNSS</h3>
          {rtkStatus.lastFix ? (
            <div className="ds-fix-card">
              <span
                className="ds-fix-badge"
                style={{ background: fixBadgeColor(rtkStatus.lastFix.fixLabel) }}
              >
                {fixBadgeLabel(rtkStatus.lastFix.fixLabel)}
              </span>
              <div className="ds-fix-details">
                <span>{rtkStatus.lastFix.satellites} satelites</span>
                <span>HDOP {rtkStatus.lastFix.hdop != null ? rtkStatus.lastFix.hdop.toFixed(1) : '--'}</span>
                <span>precision {rtkStatus.lastFix.accuracyMeters}m</span>
              </div>
            </div>
          ) : (
            <p className="ds-hint">Sin datos del receptor todavia - conecta el USB para ver el estado del fix.</p>
          )}
        </section>

        <section className="ds-section">
          <h3>Salidas</h3>
          <label className="ds-toggle-row">
            <input type="checkbox" checked={rtkStatus.mockLocationActive} onChange={toggleMockLocation} />
            Ubicacion simulada (mock location) - alimenta el fix RTK al sistema
          </label>
          <label className="ds-toggle-row">
            <input type="checkbox" checked={rtkStatus.swMapsOutputRunning} onChange={toggleSwMapsOutput} />
            Output to SW Maps - retransmite el NMEA por TCP local
          </label>
          <label className="ds-label">Puerto SW Maps</label>
          <input
            type="number"
            value={swMapsPortInput}
            onChange={(e) => setSwMapsPortInput(Number(e.target.value))}
          />
          <p className="ds-hint">
            En SW Maps: External GNSS &gt; TCP &gt; 127.0.0.1:{swMapsPortInput || rtkStatus.swMapsPort}
          </p>
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
          <h3>Servicio GNSS</h3>
          <div className="ds-actions">
            <button onClick={activateGnssService} disabled={gnssBusy}>
              Activar todo
            </button>
            <button className="ds-remove" onClick={deactivateGnssService} disabled={gnssBusy}>
              Desactivar todo
            </button>
            <button onClick={restartGnssService} disabled={gnssBusy}>
              Reiniciar
            </button>
          </div>
          <p className="ds-hint">
            Activa/apaga USB + NTRIP + ubicacion simulada + salida SW Maps juntos, en el orden
            correcto. El receptor ya se conecta y arranca todo esto solo al enchufarlo (ver
            arriba) - este boton es para forzarlo a mano si hace falta.
          </p>
          <div className="ds-actions">
            <button className="ds-remove" onClick={handleRestoreDefaults}>
              Restaurar valores por defecto
            </button>
          </div>
          <p className="ds-hint">
            Regresa servidor, NTRIP, envio continuo, baud rate y salida SW Maps a los mismos
            valores de fabrica que se aplican solos al activar Modo Operador la primera vez.
          </p>
        </section>
          </>
        ) : (
          <section className="ds-section">
            <h3>Modo operador</h3>
            <p className="ds-hint">
              Este dispositivo esta en modo basico - solo inicio de sesion, sin permisos ni
              envio de datos adicionales. Si esta tableta se va a instalar en un vehiculo,
              activa el modo operador con el codigo interno del equipo.
            </p>
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
