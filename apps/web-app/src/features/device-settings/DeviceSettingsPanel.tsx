import {
  RtkNtrip,
  TraccarSender,
  type NtripConfig,
  type RtkStatus,
  type TraccarServer,
} from '@gaga-gps/android-bridge';
import {
  getApiBaseUrl,
  getDeviceId,
  getTelemetryToken,
  setApiBaseUrl,
  setDeviceId,
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

export function DeviceSettingsPanel({ onClose }: DeviceSettingsPanelProps) {
  const [serverUrl, setServerUrl] = useState(getApiBaseUrl() || TEST_DEFAULTS.serverUrl);
  const [token, setToken] = useState(getTelemetryToken() || TEST_DEFAULTS.token);
  const [deviceId, setDeviceIdInput] = useState(getDeviceId() || TEST_DEFAULTS.deviceId);
  const [savedMessage, setSavedMessage] = useState('');

  const [extraServers, setExtraServers] = useState<TraccarServer[]>([]);
  const [senderRunning, setSenderRunning] = useState(false);
  const [senderError, setSenderError] = useState<string | null>(null);

  const [ntripConfig, setNtripConfig] = useState<Partial<NtripConfig>>({ port: 2101 });
  const [usbDevices, setUsbDevices] = useState<{ deviceId: number; name: string | null }[]>([]);
  const [rtkStatus, setRtkStatus] = useState<RtkStatus>({
    usbConnected: false,
    ntripConnected: false,
    ntripError: null,
  });

  useEffect(() => {
    TraccarSender.getServers().then((r) => setExtraServers(r.servers.filter((s) => s.id !== MAIN_SERVER_ID)));
    TraccarSender.getState().then((s) => {
      setSenderRunning(s.running);
      setSenderError(s.lastError);
    });
    RtkNtrip.getNtripConfig().then((c) => setNtripConfig((prev) => ({ ...prev, ...c })));
    RtkNtrip.getStatus().then(setRtkStatus);

    const listenerPromise = RtkNtrip.addListener('rtkStatus', (status) => setRtkStatus(status));
    const interval = setInterval(() => {
      TraccarSender.getState().then((s) => {
        setSenderRunning(s.running);
        setSenderError(s.lastError);
      });
    }, 4000);

    return () => {
      clearInterval(interval);
      listenerPromise.then((h) => h.remove());
    };
  }, []);

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

  async function refreshUsbDevices() {
    const { devices } = await RtkNtrip.listUsbDevices();
    setUsbDevices(devices);
  }

  async function connectUsb(usbDeviceId: number) {
    await RtkNtrip.connectUsb({ deviceId: usbDeviceId });
  }

  async function saveNtripConfig() {
    if (!ntripConfig.host || !ntripConfig.mountpoint) return;
    await RtkNtrip.setNtripConfig({
      host: ntripConfig.host,
      port: ntripConfig.port ?? 2101,
      mountpoint: ntripConfig.mountpoint,
      username: ntripConfig.username ?? '',
      password: ntripConfig.password ?? '',
    });
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
      await RtkNtrip.startMockLocation();
    } catch (e) {
      setRtkStatus((prev) => ({
        ...prev,
        ntripError: e instanceof Error ? e.message : 'No se pudo activar ubicacion simulada',
      }));
    }
  }

  return (
    <div className="ds-overlay">
      <div className="ds-card">
        <button className="ds-close" onClick={onClose} aria-label="Cerrar" title="Cerrar">
          X
        </button>
        <h2>Configuracion del dispositivo</h2>

        <section className="ds-section">
          <h3>Servidor y envio de posicion</h3>
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
          <div className="ds-actions">
            <button onClick={toggleSender}>{senderRunning ? 'Detener envio' : 'Iniciar envio'}</button>
            <span className="ds-status">
              {senderRunning ? 'Enviando' : 'Detenido'}
              {senderError && <span className="ds-error"> - {senderError}</span>}
            </span>
          </div>
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
          <h3>Receptor RTK (USB)</h3>
          <div className="ds-actions">
            <button onClick={refreshUsbDevices}>Buscar dispositivos USB</button>
            <span className="ds-status">{rtkStatus.usbConnected ? 'Conectado' : 'Sin conectar'}</span>
          </div>
          {usbDevices.map((d) => (
            <div className="ds-row" key={d.deviceId}>
              <span>{d.name ?? `USB ${d.deviceId}`}</span>
              <button onClick={() => connectUsb(d.deviceId)}>Conectar</button>
            </div>
          ))}
          {rtkStatus.usbConnected && (
            <button className="ds-remove" onClick={() => RtkNtrip.disconnectUsb()}>
              Desconectar USB
            </button>
          )}
        </section>

        <section className="ds-section">
          <h3>Correccion NTRIP</h3>
          <div className="ds-row">
            <input
              placeholder="Host del caster"
              value={ntripConfig.host ?? ''}
              onChange={(e) => setNtripConfig((prev) => ({ ...prev, host: e.target.value }))}
            />
            <input
              placeholder="Puerto"
              type="number"
              value={ntripConfig.port ?? 2101}
              onChange={(e) => setNtripConfig((prev) => ({ ...prev, port: Number(e.target.value) }))}
            />
          </div>
          <input
            placeholder="Mountpoint"
            value={ntripConfig.mountpoint ?? ''}
            onChange={(e) => setNtripConfig((prev) => ({ ...prev, mountpoint: e.target.value }))}
          />
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
          <div className="ds-actions">
            <button onClick={saveNtripConfig}>Guardar</button>
            <button onClick={toggleNtrip}>{rtkStatus.ntripConnected ? 'Detener NTRIP' : 'Conectar NTRIP'}</button>
            <button onClick={toggleMockLocation}>Activar ubicacion simulada</button>
          </div>
          {rtkStatus.ntripError && <div className="ds-error-block">{rtkStatus.ntripError}</div>}
          {rtkStatus.lastFix && (
            <div className="ds-fix">
              Fix: {rtkStatus.lastFix.fixLabel} - {rtkStatus.lastFix.satellites} satelites - precision{' '}
              {rtkStatus.lastFix.accuracyMeters}m
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
