import {
  RtkNtrip,
  TraccarSender,
  type CorrectionMode,
  type NtripConfig,
  type NtripMountpoint,
  type RtkFixLabel,
  type RtkStatus,
  type TraccarLogEntry,
  type TraccarSendSettings,
  type TraccarServer,
} from '@gaga-gps/android-bridge';
import {
  enableOperatorMode,
  getApiBaseUrl,
  getDeviceId,
  getSettingsPassword,
  getTelemetryToken,
  hasSettingsPassword,
  isOperatorModeEnabled,
  setApiBaseUrl,
  setDeviceId,
  setSettingsPassword,
  setTelemetryToken,
} from '@gaga-gps/client';
import { useEffect, useState } from 'react';
import './device-settings.css';

const MAIN_SERVER_ID = 'gaga-main';

export interface DeviceSettingsPanelProps {
  onClose: () => void;
}

function buildMainServerUrl(serverUrl: string, token: string): string {
  const base = serverUrl.trim().replace(/\/+$/, '');
  const query = token.trim() ? `?key=${encodeURIComponent(token.trim())}` : '';
  return `${base}/gps${query}`;
}

function emptyExtraServer(): TraccarServer {
  return { id: crypto.randomUUID(), url: '', enabled: true };
}

// valores de prueba precargados a pedido del usuario mientras se hacen las pruebas de campo -
// solo rellenan el formulario la primera vez (si ya hay algo guardado, gana lo guardado)
const TEST_DEFAULTS = { serverUrl: 'https://app.gaga-maquinaria.com', token: 'test', deviceId: 'T2' };

// codigo de "configuracion rapida" - rellena servidor/token/NTRIP conocidos y activa el modo
// automatico de un golpe, para no tener que escribirlo a mano en cada tableta que se provisiona.
// El identificador del dispositivo y el mount point NUNCA se llenan solos a proposito (varian por
// tableta/ubicacion). Para cambiar este codigo, solo pide que se edite aqui.
// codigo interno de "modo operador" - solo el equipo de desarrollo debe conocerlo. Un dispositivo
// nuevo llega en modo basico (login + panel normal, sin permisos extra); activar modo operador
// revela todo lo que hay debajo de este comentario y ya no se puede desactivar sin reinstalar la
// app. Cambiar el codigo aqui si hace falta.
const OPERATOR_MODE_CODE = '3009';

const QUICK_FILL_CODE = '4077';
const QUICK_FILL_VALUES = {
  serverUrl: 'https://app.gaga-maquinaria.com',
  token: 'test',
  ntripHost: 'ntrip.earthscope.org',
  ntripPort: 2101,
  ntripUsername: 'nervous_raman',
  ntripPassword: 'Lh4lI10A0brg43QO',
  ntripVersion: 'v2' as const,
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

  const [showQuickFill, setShowQuickFill] = useState(false);
  const [quickFillInput, setQuickFillInput] = useState('');
  const [quickFillError, setQuickFillError] = useState('');
  const [quickFillMessage, setQuickFillMessage] = useState('');

  const [serverUrl, setServerUrl] = useState(getApiBaseUrl() || TEST_DEFAULTS.serverUrl);
  const [token, setToken] = useState(getTelemetryToken() || TEST_DEFAULTS.token);
  const [deviceId, setDeviceIdInput] = useState(getDeviceId() || TEST_DEFAULTS.deviceId);
  const [savedMessage, setSavedMessage] = useState('');

  const [extraServers, setExtraServers] = useState<TraccarServer[]>([]);
  const [senderRunning, setSenderRunning] = useState(false);
  const [senderError, setSenderError] = useState<string | null>(null);
  const [bufferedCount, setBufferedCount] = useState(0);
  const [sendNowMessage, setSendNowMessage] = useState('');

  const [sendSettings, setSendSettings] = useState<TraccarSendSettings | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [logEntries, setLogEntries] = useState<TraccarLogEntry[]>([]);

  const [ntripConfig, setNtripConfig] = useState<Partial<NtripConfig>>({ port: 2101, version: 'v2' });
  const [usbDevices, setUsbDevices] = useState<{ deviceId: number; name: string | null }[]>([]);
  const [selectedUsbDeviceId, setSelectedUsbDeviceId] = useState<number | null>(null);
  const [baudRate, setBaudRateInput] = useState(460800);
  const [correctionMode, setCorrectionModeState] = useState<CorrectionMode>('ntrip');
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
    // en modo basico (sin activar) no se llama a ningun plugin nativo - ni una vez, ni en el
    // polling periodico de abajo - asi Android nunca pide permisos de ubicacion/USB de mas
    if (!operatorMode) return;

    TraccarSender.getServers().then((r) => setExtraServers(r.servers.filter((s) => s.id !== MAIN_SERVER_ID)));
    TraccarSender.getSendSettings().then(setSendSettings);
    refreshState();
    RtkNtrip.getNtripConfig().then((c) => setNtripConfig((prev) => ({ ...prev, ...c })));
    RtkNtrip.getBaudRate().then((r) => setBaudRateInput(r.baudRate));
    RtkNtrip.getCorrectionMode().then((r) => setCorrectionModeState(r.mode));
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

  async function persistExtraServers(next: TraccarServer[]) {
    setExtraServers(next);
    const mainServer: TraccarServer = {
      id: MAIN_SERVER_ID,
      url: buildMainServerUrl(serverUrl, token),
      enabled: true,
    };
    await TraccarSender.saveServers({
      servers: [mainServer, ...next.filter((s) => s.url.trim() !== '')],
    });
  }

  async function saveMainConfig() {
    setApiBaseUrl(serverUrl);
    setTelemetryToken(token);
    setDeviceId(deviceId);
    await TraccarSender.setDeviceId({ deviceId: deviceId.trim() || 'GAGA-DEVICE' });
    await persistExtraServers(extraServers);
    setSavedMessage('Guardado');
    setTimeout(() => setSavedMessage(''), 2000);
  }

  function updateExtraServer(id: string, patch: Partial<TraccarServer>) {
    persistExtraServers(extraServers.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function removeExtraServer(id: string) {
    persistExtraServers(extraServers.filter((s) => s.id !== id));
  }

  function addExtraServer() {
    persistExtraServers([...extraServers, emptyExtraServer()]);
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

  async function handleResetSendSettings() {
    const restored = await TraccarSender.resetSendSettings();
    setSendSettings(restored);
  }

  async function refreshUsbDevices() {
    const { devices } = await RtkNtrip.listUsbDevices();
    setUsbDevices(devices);
  }

  async function refreshRtkStatus() {
    RtkNtrip.getStatus().then(setRtkStatus);
  }

  async function connectUsb() {
    if (selectedUsbDeviceId == null) return;
    await RtkNtrip.setBaudRate({ baudRate });
    await RtkNtrip.connectUsb({ deviceId: selectedUsbDeviceId, baudRate });
  }

  async function saveNtripConfig() {
    if (!ntripConfig.host || !ntripConfig.mountpoint) return;
    await RtkNtrip.setNtripConfig({
      host: ntripConfig.host,
      port: ntripConfig.port ?? 2101,
      mountpoint: ntripConfig.mountpoint,
      username: ntripConfig.username ?? '',
      password: ntripConfig.password ?? '',
      version: ntripConfig.version ?? 'v2',
    });
  }

  async function searchMountpoints() {
    if (!ntripConfig.host) return;
    setMountpointsLoading(true);
    setMountpointsError('');
    try {
      const { mountpoints: found } = await RtkNtrip.fetchSourceTable({
        host: ntripConfig.host,
        port: ntripConfig.port ?? 2101,
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
    await saveNtripConfig();
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

  async function updateCorrectionMode(mode: CorrectionMode) {
    if (mode !== 'ntrip') return; // pointperfect/usb_serial bloqueados, ver render mas abajo
    setCorrectionModeState(mode);
    await RtkNtrip.setCorrectionMode({ mode });
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
      await saveNtripConfig();
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

  function handleActivateOperatorMode() {
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

  // rellena servidor/token/NTRIP conocidos y activa el modo automatico de un golpe - deviceId y
  // mountpoint se quedan sin tocar a proposito, esos siempre son manuales por tableta/ubicacion
  async function handleQuickFill() {
    if (quickFillInput.trim() !== QUICK_FILL_CODE) {
      setQuickFillError('Codigo incorrecto');
      return;
    }
    setQuickFillError('');
    setServerUrl(QUICK_FILL_VALUES.serverUrl);
    setToken(QUICK_FILL_VALUES.token);
    setNtripConfig((prev) => ({
      ...prev,
      host: QUICK_FILL_VALUES.ntripHost,
      port: QUICK_FILL_VALUES.ntripPort,
      username: QUICK_FILL_VALUES.ntripUsername,
      password: QUICK_FILL_VALUES.ntripPassword,
      version: QUICK_FILL_VALUES.ntripVersion,
    }));
    await RtkNtrip.setAutoMode({ enabled: true });
    await refreshRtkStatus();
    setQuickFillInput('');
    setShowQuickFill(false);
    setQuickFillMessage('Listo - falta identificador del dispositivo y elegir el mount point NTRIP');
    setTimeout(() => setQuickFillMessage(''), 6000);
  }

  async function disableAutoMode() {
    await RtkNtrip.setAutoMode({ enabled: false });
    await refreshRtkStatus();
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
            <button onClick={() => setShowQuickFill((v) => !v)}>Configuracion rapida</button>
          </div>
          {showQuickFill && (
            <div className="ds-row">
              <input
                placeholder="Codigo de 4 digitos"
                value={quickFillInput}
                onChange={(e) => setQuickFillInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleQuickFill()}
              />
              <button onClick={handleQuickFill}>Aplicar</button>
            </div>
          )}
          {quickFillError && <div className="ds-error-block">{quickFillError}</div>}
          {quickFillMessage && <div className="ds-saved">{quickFillMessage}</div>}
          <label className="ds-label">Servidor GAGA GPS</label>
          <input
            placeholder="http://192.168.1.50:3001"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
          />
          <label className="ds-label">Token de telemetria</label>
          <input
            placeholder="TELEMETRY_SHARED_SECRET del servidor"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <label className="ds-label">Identificador del dispositivo</label>
          <input
            placeholder="Igual que en Traccar Client"
            value={deviceId}
            onChange={(e) => setDeviceIdInput(e.target.value)}
          />
          <div className="ds-actions">
            <button onClick={saveMainConfig}>Guardar</button>
            {savedMessage && <span className="ds-saved">{savedMessage}</span>}
          </div>
          <p className="ds-hint">
            El envio de posicion manda a {serverUrl ? buildMainServerUrl(serverUrl, token) : '(configura el servidor primero)'}
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
          <h3>Envio de posicion</h3>
          <div className="ds-actions">
            <button onClick={toggleSender}>{senderRunning ? 'Detener envio continuo' : 'Iniciar envio continuo'}</button>
            <button onClick={handleSendNow}>Enviar ubicacion ahora</button>
          </div>
          <div className="ds-actions">
            <span className="ds-status">
              {senderRunning ? 'Enviando' : 'Detenido'}
              {bufferedCount > 0 && ` - ${bufferedCount} en buffer sin conexion`}
              {senderError && <span className="ds-error"> - {senderError}</span>}
            </span>
            {sendNowMessage && <span className="ds-saved">{sendNowMessage}</span>}
          </div>

          {sendSettings && (
            <>
              <label className="ds-label">Intervalo de envio (segundos)</label>
              <input
                type="number"
                min={1}
                value={sendSettings.intervalSeconds}
                onChange={(e) => updateSendSettings({ intervalSeconds: Number(e.target.value) })}
              />
              <label className="ds-label">Contrasena (opcional, protocolo OsmAnd)</label>
              <input
                type="password"
                value={sendSettings.password}
                onChange={(e) => updateSendSettings({ password: e.target.value })}
              />
              <p className="ds-hint">
                GPS y buffer sin conexion siempre estan activos al maximo - no hay ajustes que solo
                empeorarian el envio, lo unico que tiene sentido tocar aqui es el intervalo.
              </p>

              <div className="ds-actions">
                <button className="ds-remove" onClick={handleResetSendSettings}>
                  Restaurar intervalo por defecto
                </button>
              </div>
            </>
          )}

          <button className="ds-add" onClick={() => setShowLog((v) => !v)}>
            {showLog ? 'Ocultar bitacora' : 'Mostrar estado (bitacora de envio)'}
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

        <section className="ds-section">
          <h3>Servidores adicionales (opcional)</h3>
          {extraServers.map((server) => (
            <div className="ds-row" key={server.id}>
              <input
                placeholder="http://otro-servidor:5055"
                value={server.url}
                onChange={(e) => updateExtraServer(server.id, { url: e.target.value })}
              />
              <label className="ds-toggle">
                <input
                  type="checkbox"
                  checked={server.enabled}
                  onChange={(e) => updateExtraServer(server.id, { enabled: e.target.checked })}
                />
                Activo
              </label>
              <button className="ds-remove" onClick={() => removeExtraServer(server.id)}>
                Quitar
              </button>
            </div>
          ))}
          <button className="ds-add" onClick={addExtraServer}>
            + Agregar servidor adicional
          </button>
        </section>

        <section className="ds-section">
          <h3>Modo de correccion</h3>
          <div className="ds-mode-row">
            <label className={`ds-mode-option ${correctionMode === 'ntrip' ? 'ds-mode-active' : ''}`}>
              <input
                type="radio"
                name="correctionMode"
                checked={correctionMode === 'ntrip'}
                onChange={() => updateCorrectionMode('ntrip')}
              />
              NTRIP Client
            </label>
            <label className="ds-mode-option ds-mode-disabled" title="Proximamente">
              <input type="radio" name="correctionMode" disabled />
              PointPerfect
            </label>
            <label className="ds-mode-option ds-mode-disabled" title="Proximamente">
              <input type="radio" name="correctionMode" disabled />
              USB Serial
            </label>
          </div>
          <p className="ds-hint">PointPerfect y USB Serial estan contempladas pero bloqueadas por ahora.</p>
        </section>

        <section className="ds-section">
          <h3>Receptor RTK (USB)</h3>
          <div className="ds-actions">
            <button onClick={refreshUsbDevices}>Buscar dispositivos USB</button>
            <span className="ds-status">
              {rtkStatus.usbConnected
                ? `Conectado - ${rtkStatus.connectedUsbDeviceName ?? 'USB'} - ${formatRate(rtkStatus.usbDataRateBps)} - ${formatTotalBytes(rtkStatus.usbTotalBytes)} total`
                : 'Sin conectar'}
            </span>
          </div>
          {usbDevices.map((d) => (
            <label className="ds-usb-option" key={d.deviceId}>
              <input
                type="radio"
                name="usbDevice"
                checked={selectedUsbDeviceId === d.deviceId}
                onChange={() => setSelectedUsbDeviceId(d.deviceId)}
              />
              {d.name ?? `USB ${d.deviceId}`}
            </label>
          ))}
          {usbDevices.length === 0 && <p className="ds-hint">Ningun dispositivo USB detectado todavia.</p>}
          <label className="ds-label">Baud rate</label>
          <input
            type="number"
            value={baudRate}
            onChange={(e) => setBaudRateInput(Number(e.target.value))}
          />
          <div className="ds-actions">
            <button onClick={connectUsb} disabled={selectedUsbDeviceId == null}>
              Conectar
            </button>
            {rtkStatus.usbConnected && (
              <button className="ds-remove" onClick={() => RtkNtrip.disconnectUsb()}>
                Desconectar
              </button>
            )}
          </div>
        </section>

        <section className="ds-section">
          <h3>Correccion NTRIP</h3>
          <div className="ds-row">
            <input
              placeholder="NTRIP address"
              value={ntripConfig.host ?? ''}
              onChange={(e) => setNtripConfig((prev) => ({ ...prev, host: e.target.value }))}
            />
            <input
              placeholder="NTRIP port"
              type="number"
              value={ntripConfig.port ?? 2101}
              onChange={(e) => setNtripConfig((prev) => ({ ...prev, port: Number(e.target.value) }))}
            />
          </div>
          <div className="ds-row">
            <input
              placeholder="Mount point"
              value={ntripConfig.mountpoint ?? ''}
              onChange={(e) => setNtripConfig((prev) => ({ ...prev, mountpoint: e.target.value }))}
            />
            <button onClick={searchMountpoints} disabled={!ntripConfig.host || mountpointsLoading}>
              {mountpointsLoading ? 'Buscando...' : 'Buscar puntos de montura'}
            </button>
          </div>
          {mountpointsError && <div className="ds-error-block">{mountpointsError}</div>}
          {mountpoints.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                setNtripConfig((prev) => ({ ...prev, mountpoint: e.target.value }));
              }}
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
              value={ntripConfig.username ?? ''}
              onChange={(e) => setNtripConfig((prev) => ({ ...prev, username: e.target.value }))}
            />
            <input
              placeholder="Contrasena"
              type="password"
              value={ntripConfig.password ?? ''}
              onChange={(e) => setNtripConfig((prev) => ({ ...prev, password: e.target.value }))}
            />
          </div>
          <label className="ds-label">Version NTRIP</label>
          <select
            value={ntripConfig.version ?? 'v2'}
            onChange={(e) => setNtripConfig((prev) => ({ ...prev, version: e.target.value as NtripConfig['version'] }))}
          >
            <option value="v1">V1</option>
            <option value="v2">V2</option>
          </select>
          <div className="ds-actions">
            <button onClick={saveNtripConfig}>Guardar</button>
            <button onClick={toggleNtrip}>{rtkStatus.ntripConnected ? 'Detener NTRIP' : 'Conectar NTRIP'}</button>
          </div>
          <div className="ds-actions">
            <span className="ds-status">
              {rtkStatus.ntripConnected
                ? `Conectado - ${formatRate(rtkStatus.ntripDataRateBps)} - ${formatTotalBytes(rtkStatus.ntripTotalBytes)} total`
                : 'Sin conectar'}
            </span>
          </div>
          {rtkStatus.ntripError && <div className="ds-error-block">{rtkStatus.ntripError}</div>}
        </section>

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
            Activa/apaga USB + NTRIP + ubicacion simulada + salida SW Maps juntos, en el orden correcto.
          </p>
          <div className="ds-actions">
            <span className="ds-status">
              Modo automatico: {rtkStatus.autoModeEnabled ? 'Activado' : 'Desactivado'}
            </span>
            {rtkStatus.autoModeEnabled && (
              <button className="ds-remove" onClick={disableAutoMode}>
                Desactivar modo automatico
              </button>
            )}
          </div>
          <p className="ds-hint">
            Con el modo automatico activado: al conectar el USB del receptor se conecta y arranca NTRIP
            solo (si ya hay un mount point guardado); al desconectarlo, todo se apaga solo y el sistema
            usa el GPS normal de la tableta hasta que el receptor se vuelva a conectar.
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
