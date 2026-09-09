import { useEffect, useState } from 'react';
import { adminApi } from '../api';
import type { HealthResponse } from '../types';

export function SystemSection() {
  const [text, setText] = useState('');
  const [telemetrySecret, setTelemetrySecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

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

  useEffect(() => {
    loadHealth();
    loadSettings();
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
        <h3>Estado del sistema</h3>
        <pre style={{ fontSize: 13, color: '#c9d1d9' }}>{text}</pre>
        <button className="btn btn-sm" style={{ width: 'auto', marginTop: 10 }} onClick={loadHealth}>
          Actualizar
        </button>
      </div>
    </>
  );
}
