import { getStoredToken } from '@gaga-gps/client';
import { Modal } from '@gaga-gps/ui';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { adminApi } from '../api';
import type { AppReleaseRow, DeviceRow, HealthResponse } from '../types';

interface QrProvisioningResponse {
  versionCode: number;
  versionName: string;
  provisioningPayload: Record<string, string | boolean>;
}

interface DownloadQrResponse {
  versionCode: number;
  versionName: string;
  downloadUrl: string;
}

function uploadApk(
  formData: FormData,
  onProgress: (percent: number) => void,
): Promise<AppReleaseRow> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/app/release');
    const token = getStoredToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
        return;
      }
      let message = `Error ${xhr.status}`;
      try {
        message = JSON.parse(xhr.responseText).error || message;
      } catch {
        // respuesta no era JSON - se queda el mensaje generico
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error('Error de red al subir el APK'));
    xhr.send(formData);
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SystemSection() {
  const [text, setText] = useState('');
  const [telemetrySecret, setTelemetrySecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const [releases, setReleases] = useState<AppReleaseRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState('');
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [forceUpdateBusy, setForceUpdateBusy] = useState(false);
  const [forceUpdateMessage, setForceUpdateMessage] = useState('');

  const [showQrModal, setShowQrModal] = useState(false);
  const [qrBusy, setQrBusy] = useState(false);
  const [qrError, setQrError] = useState('');
  const [qrImage, setQrImage] = useState('');
  const [qrInfo, setQrInfo] = useState<QrProvisioningResponse | null>(null);

  const [showDownloadQrModal, setShowDownloadQrModal] = useState(false);
  const [downloadQrBusy, setDownloadQrBusy] = useState(false);
  const [downloadQrError, setDownloadQrError] = useState('');
  const [downloadQrImage, setDownloadQrImage] = useState('');
  const [downloadQrInfo, setDownloadQrInfo] = useState<DownloadQrResponse | null>(null);

  async function loadHealth() {
    try {
      const health: HealthResponse = await fetch('/health').then((r) => r.json());
      setText(JSON.stringify(health, null, 2));
    } catch (err) {
      setText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function loadSettings() {
    try {
      const settings = await adminApi.get<{ telemetrySharedSecret: string | null }>('/api/settings');
      setTelemetrySecret(settings.telemetrySharedSecret ?? '');
    } catch {
      // sin bloquear el resto de la sección si esto falla
    }
  }

  async function loadReleases() {
    try {
      setReleases(await adminApi.get<AppReleaseRow[]>('/api/app/releases'));
    } catch {
      // sin bloquear el resto de la sección si esto falla
    }
  }

  async function loadDevices() {
    try {
      setDevices(await adminApi.get<DeviceRow[]>('/api/devices'));
    } catch {
      // sin bloquear el resto de la sección si esto falla
    }
  }

  useEffect(() => {
    loadHealth();
    loadSettings();
    loadReleases();
    loadDevices();
  }, []);

  async function saveTelemetrySecret() {
    setSaveStatus('saving');
    try {
      await adminApi.patch('/api/settings', { key: 'telemetrySharedSecret', value: telemetrySecret || null });
      setSaveStatus('saved');
    } catch {
      setSaveStatus('error');
    }
  }

  const latestRelease = releases[0] ?? null;

  async function handlePublish() {
    const file = fileInputRef.current?.files?.[0];
    setUploadError('');
    if (!file) return setUploadError('Selecciona un archivo .apk');

    const formData = new FormData();
    formData.append('apk', file);

    setUploadProgress(0);
    try {
      await uploadApk(formData, setUploadProgress);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await loadReleases();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Error publicando el release');
    } finally {
      setUploadProgress(null);
    }
  }

  async function openQrModal() {
    setShowQrModal(true);
    setQrBusy(true);
    setQrError('');
    setQrImage('');
    setQrInfo(null);
    try {
      const info = await adminApi.get<QrProvisioningResponse>('/api/app/qr-provisioning');
      setQrInfo(info);
      const dataUrl = await QRCode.toDataURL(JSON.stringify(info.provisioningPayload), {
        width: 320,
        margin: 2,
      });
      setQrImage(dataUrl);
    } catch (err) {
      setQrError(err instanceof Error ? err.message : 'Error generando el QR');
    } finally {
      setQrBusy(false);
    }
  }

  async function openDownloadQrModal() {
    setShowDownloadQrModal(true);
    setDownloadQrBusy(true);
    setDownloadQrError('');
    setDownloadQrImage('');
    setDownloadQrInfo(null);
    try {
      const info = await adminApi.get<DownloadQrResponse>('/api/app/download-qr');
      setDownloadQrInfo(info);
      const dataUrl = await QRCode.toDataURL(info.downloadUrl, { width: 320, margin: 2 });
      setDownloadQrImage(dataUrl);
    } catch (err) {
      setDownloadQrError(err instanceof Error ? err.message : 'Error generando el QR');
    } finally {
      setDownloadQrBusy(false);
    }
  }

  async function forceUpdate(deviceId?: string) {
    const confirmMessage = deviceId
      ? `Esto le pide a la tableta "${deviceId}" que revise e instale la actualización ahora mismo, sin ningún aviso en su pantalla. Solo funciona si esa tableta tiene la app abierta y conectada en este momento - si no, se pondrá al día sola en su próxima revisión programada (2 AM).\n\n¿Continuar?`
      : 'Esto le pide a TODAS las tabletas conectadas ahora mismo que revisen e instalen la actualización de inmediato, sin ningún aviso en pantalla. Una tableta apagada o sin conexión en este momento se pondrá al día sola en su próxima revisión programada (2 AM), no ahora.\n\n¿Continuar?';
    if (!confirm(confirmMessage)) return;

    setForceUpdateBusy(true);
    setForceUpdateMessage('');
    try {
      await adminApi.post('/api/app/force-update', deviceId ? { deviceId } : {});
      setForceUpdateMessage('Señal enviada');
    } catch (err) {
      setForceUpdateMessage(err instanceof Error ? err.message : 'Error enviando la señal');
    } finally {
      setForceUpdateBusy(false);
      setTimeout(() => setForceUpdateMessage(''), 3000);
    }
  }

  return (
    <>
      <div className="card">
        <h3>Configuración global</h3>
        <div className="form-row">
          <label>Telemetry shared secret</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type={showSecret ? 'text' : 'password'}
              value={telemetrySecret}
              onChange={(e) => {
                setTelemetrySecret(e.target.value);
                setSaveStatus('idle');
              }}
              placeholder="Sin configurar - /gps queda sin candado de clave compartida"
              style={{ flex: 1 }}
            />
            <button className="btn btn-sm" type="button" onClick={() => setShowSecret((v) => !v)}>
              {showSecret ? 'Ocultar' : 'Mostrar'}
            </button>
          </div>
        </div>
        <button className="btn btn-sm" style={{ width: 'auto', marginTop: 10 }} onClick={saveTelemetrySecret}>
          {saveStatus === 'saving' ? 'Guardando…' : 'Guardar'}
        </button>
        {saveStatus === 'saved' && <span style={{ marginLeft: 10, color: '#3fb950' }}>Guardado</span>}
        {saveStatus === 'error' && <span style={{ marginLeft: 10, color: '#f85149' }}>Error al guardar</span>}
      </div>

      <div className="card">
        <h3>Actualización de la app (tabletas)</h3>
        <p style={{ fontSize: 13, color: '#7d93b8' }}>
          {latestRelease
            ? `Última versión publicada: ${latestRelease.version_name} (build ${latestRelease.version_code}), ${formatBytes(latestRelease.size_bytes)}.`
            : 'Todavía no se ha publicado ningún release.'}
        </p>

        <p style={{ fontSize: 12, color: '#7d93b8' }}>
          El version code y version name se leen directo del APK (lo que hayas puesto en
          build.gradle antes de compilar) - no hace falta escribirlos aquí. Se rechaza si el
          version code no es mayor al ya publicado.
        </p>
        <div className="form-row">
          <label>Archivo APK</label>
          <input ref={fileInputRef} type="file" accept=".apk" />
        </div>
        <button
          className="btn btn-sm"
          style={{ width: 'auto', marginTop: 10 }}
          onClick={handlePublish}
          disabled={uploadProgress !== null}
        >
          {uploadProgress !== null ? `Subiendo… ${uploadProgress}%` : 'Publicar'}
        </button>
        {uploadError && <div style={{ marginTop: 8, color: '#f85149' }}>{uploadError}</div>}

        <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn btn-sm"
            style={{ width: 'auto' }}
            onClick={() => forceUpdate()}
            disabled={forceUpdateBusy || !latestRelease}
          >
            Actualizar todos los dispositivos
          </button>
          <select value={selectedDeviceId} onChange={(e) => setSelectedDeviceId(e.target.value)}>
            <option value="">Selecciona una tableta…</option>
            {devices.map((d) => (
              <option key={d.unique_id} value={d.unique_id}>
                {d.name} ({d.unique_id})
              </option>
            ))}
          </select>
          <button
            className="btn btn-sm"
            style={{ width: 'auto' }}
            onClick={() => forceUpdate(selectedDeviceId)}
            disabled={forceUpdateBusy || !selectedDeviceId || !latestRelease}
          >
            Actualizar esta tableta
          </button>
          {forceUpdateMessage && <span style={{ color: '#3fb950' }}>{forceUpdateMessage}</span>}
        </div>
        <p style={{ fontSize: 12, color: '#7d93b8', marginTop: 8 }}>
          "Actualizar" solo llega de inmediato a una tableta con la app abierta y conectada en ese
          momento - las demás se ponen al día solas en su revisión diaria de las 2 AM.
        </p>

        {releases.length > 0 && (
          <table style={{ width: '100%', marginTop: 16, fontSize: 13, borderCollapse: 'collapse' }}>
            <colgroup>
              <col style={{ width: '15%' }} />
              <col style={{ width: '20%' }} />
              <col style={{ width: '15%' }} />
              <col style={{ width: '25%' }} />
              <col style={{ width: '25%' }} />
            </colgroup>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #30363d' }}>
                <th>Build</th>
                <th>Versión</th>
                <th>Tamaño</th>
                <th>Publicado</th>
                <th>Por</th>
              </tr>
            </thead>
            <tbody>
              {releases.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid #21262d' }}>
                  <td>{r.version_code}</td>
                  <td>{r.version_name}</td>
                  <td>{formatBytes(r.size_bytes)}</td>
                  <td>{new Date(r.released_at).toLocaleString()}</td>
                  <td>{r.released_by_email ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" style={{ width: 'auto' }} onClick={openQrModal} disabled={!latestRelease}>
            Generar QR de aprovisionamiento
          </button>
          <button
            className="btn btn-sm"
            style={{ width: 'auto' }}
            onClick={openDownloadQrModal}
            disabled={!latestRelease}
          >
            Generar QR de descarga
          </button>
        </div>
        <p style={{ fontSize: 12, color: '#7d93b8', marginTop: 8 }}>
          <strong>Aprovisionamiento</strong>: para una tableta NUEVA o recién reseteada de fábrica -
          en teoría deja la app instalada como dueña del dispositivo (Device Owner) sin computadora
          ni cable, escaneando este código durante la configuración inicial. Bloqueado en la
          práctica en hardware real por la política de Google de 2025 (allowlist de Play Protect
          para DPCs no registrados) - usar `adb shell dpm set-device-owner` en su lugar mientras
          tanto. <strong>Descarga</strong>: no aprovisiona nada, solo abre la última APK publicada en
          el navegador al escanearlo - útil para instalar/actualizar a mano sin teclear la URL en la
          tableta.
        </p>
      </div>

      <Modal open={showQrModal} title="QR de aprovisionamiento" onClose={() => setShowQrModal(false)}>
        {qrBusy && <p>Generando…</p>}
        {qrError && <div style={{ color: '#f85149' }}>{qrError}</div>}
        {qrImage && qrInfo && (
          <div style={{ textAlign: 'center' }}>
            <img src={qrImage} alt="QR de aprovisionamiento" style={{ maxWidth: '100%' }} />
            <p style={{ fontSize: 13, color: '#7d93b8', marginTop: 8 }}>
              Versión {qrInfo.versionName} (build {qrInfo.versionCode})
            </p>
            <ol style={{ textAlign: 'left', fontSize: 13, color: '#c9d1d9' }}>
              <li>Resetea de fábrica la tableta (o usa una nueva sin configurar).</li>
              <li>
                En la primera pantalla de bienvenida, toca 6 veces en cualquier parte de la
                pantalla - abre un lector de código QR.
              </li>
              <li>Conecta WiFi cuando lo pida (necesita internet para descargar la app).</li>
              <li>Escanea este código y sigue las instrucciones en pantalla.</li>
            </ol>
            <p style={{ fontSize: 12, color: '#7d93b8' }}>
              Sin verificar en hardware real todavía - probar con una tableta reseteada antes de
              confiar en esto para una instalación real.
            </p>
          </div>
        )}
      </Modal>

      <Modal open={showDownloadQrModal} title="QR de descarga" onClose={() => setShowDownloadQrModal(false)}>
        {downloadQrBusy && <p>Generando…</p>}
        {downloadQrError && <div style={{ color: '#f85149' }}>{downloadQrError}</div>}
        {downloadQrImage && downloadQrInfo && (
          <div style={{ textAlign: 'center' }}>
            <img src={downloadQrImage} alt="QR de descarga" style={{ maxWidth: '100%' }} />
            <p style={{ fontSize: 13, color: '#7d93b8', marginTop: 8 }}>
              Versión {downloadQrInfo.versionName} (build {downloadQrInfo.versionCode})
            </p>
            <p style={{ fontSize: 13, color: '#c9d1d9', textAlign: 'left' }}>
              Escanéalo con cualquier lector de QR (o la cámara) en la tableta - abre la descarga
              del APK directo en el navegador. Usa siempre la clave configurada arriba
              ("Telemetry shared secret") en este momento, así que si la cambias hay que generar
              este QR de nuevo.
            </p>
          </div>
        )}
      </Modal>

      <div className="card">
        <h3>Estado del sistema</h3>
        <pre style={{ fontSize: 13, color: '#c9d1d9' }}>{text}</pre>
        <button className="btn btn-sm" style={{ width: 'auto', marginTop: 10 }} onClick={loadHealth}>
          Actualizar
        </button>
      </div>
    </>
  );
}
