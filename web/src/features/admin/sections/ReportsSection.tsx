import { getStoredToken } from '@gaga-gps/client';
import { useState } from 'react';

export function ReportsSection() {
  const [deviceId, setDeviceId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  async function exportCsv() {
    if (!deviceId || !from || !to) {
      alert('Complete todos los campos');
      return;
    }
    const url = `/api/reports/history/csv?deviceId=${encodeURIComponent(deviceId)}&from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`;
    const token = getStoredToken();
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    // blob: Chrome bloquea esta descarga fuera de HTTPS/localhost exacto
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `historial_${deviceId}.csv`;
    a.click();
  }

  return (
    <div className="card">
      <h3>Exportar historial (CSV)</h3>
      <div className="form-row">
        <input
          placeholder="ID dispositivo"
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
        />
        <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="btn btn-sm" onClick={exportCsv}>
          Descargar CSV
        </button>
      </div>
    </div>
  );
}
