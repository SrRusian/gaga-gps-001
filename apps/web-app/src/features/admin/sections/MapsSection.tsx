import { getStoredToken } from '@gaga-gps/client';
import { useEffect, useRef, useState } from 'react';
import { adminApi } from '../api';
import type { MapRow } from '../types';

const MAP_STATUS_LABEL: Record<string, string> = {
  processing: '⏳ Procesando…',
  ready: '✅ Listo',
  failed: '❌ Error',
};

const CRS_OPTIONS = [
  { value: 'EPSG:32611', label: 'UTM zona 11N (EPSG:32611)' },
  { value: 'EPSG:32612', label: 'UTM zona 12N (EPSG:32612)' },
  { value: 'EPSG:32613', label: 'UTM zona 13N (EPSG:32613)' },
  { value: 'EPSG:32614', label: 'UTM zona 14N (EPSG:32614)' },
  { value: 'EPSG:32615', label: 'UTM zona 15N (EPSG:32615)' },
  { value: 'EPSG:32616', label: 'UTM zona 16N (EPSG:32616)' },
  { value: 'EPSG:4326', label: 'WGS84 lat/lon (EPSG:4326)' },
];

export function MapsSection() {
  const [maps, setMaps] = useState<MapRow[]>([]);
  const [name, setName] = useState('');
  const [crs, setCrs] = useState('EPSG:32613');
  const [error, setError] = useState('');
  const imageRef = useRef<HTMLInputElement>(null);
  const worldRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function loadMaps() {
    const data = await adminApi.get<MapRow[]>('/api/maps');
    setMaps(data);

    const stillProcessing = data.some((m) => m.status === 'processing');
    if (stillProcessing && !pollRef.current) {
      pollRef.current = setInterval(loadMaps, 3000);
    } else if (!stillProcessing && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  useEffect(() => {
    loadMaps();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function importMap() {
    setError('');
    const imageFile = imageRef.current?.files?.[0];
    const worldFile = worldRef.current?.files?.[0];
    if (!name.trim() || !imageFile || !worldFile) {
      setError('Completa nombre, imagen y world file');
      return;
    }

    const formData = new FormData();
    formData.append('name', name.trim());
    formData.append('sourceCrs', crs);
    formData.append('image', imageFile);
    formData.append('worldFile', worldFile);

    try {
      const token = getStoredToken();
      const res = await fetch('/api/maps', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Error ${res.status}`);
      }
      setName('');
      if (imageRef.current) imageRef.current.value = '';
      if (worldRef.current) worldRef.current.value = '';
      loadMaps();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error importando el mapa');
    }
  }

  async function activateMap(id: number) {
    if (
      !confirm(
        '¿Activar este mapa? Se sumará como capa visible para Operador/Supervisor (pueden verse varios mapas activos a la vez, apilados por fecha).',
      )
    )
      return;
    await adminApi.post(`/api/maps/${id}/activate`);
    loadMaps();
  }

  async function deactivateMap(id: number) {
    if (!confirm('¿Desactivar este mapa? Dejará de verse en Operador/Supervisor.')) return;
    await adminApi.post(`/api/maps/${id}/deactivate`);
    loadMaps();
  }

  async function renameMap(id: number, currentName: string) {
    const name = prompt('Nuevo nombre:', currentName);
    if (!name) return;
    await adminApi.patch(`/api/maps/${id}`, { name });
    loadMaps();
  }

  async function deleteMap(id: number) {
    if (!confirm('¿Eliminar este mapa? Se borra también su archivo .mbtiles.')) return;
    try {
      await adminApi.delete(`/api/maps/${id}`);
      loadMaps();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error eliminando el mapa');
    }
  }

  return (
    <>
      <div className="card">
        <h3>Importar mapa satelital/drone</h3>
        <p style={{ fontSize: 12, color: '#8b949e', margin: '0 0 8px' }}>
          Sube el par de archivos georreferenciados (imagen + world file). El sistema intenta
          detectar el sistema de coordenadas (CRS) automáticamente; si no lo logra, se usa el que
          elijas aquí — confírmalo, un CRS incorrecto ubica el mapa en el lugar o a la escala
          equivocada sin ningún aviso.
        </p>
        <div className="form-row">
          <input
            placeholder="Nombre (ej. Levantamiento julio 2026)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="form-row">
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12, color: '#8b949e' }}>Imagen (.tif / .jpg)</label>
            <input ref={imageRef} type="file" accept=".tif,.tiff,.jpg,.jpeg" />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12, color: '#8b949e' }}>World file (.tfw / .jpw)</label>
            <input ref={worldRef} type="file" accept=".tfw,.jpw,.wld" />
          </div>
        </div>
        <div className="form-row">
          <select style={{ flex: 1 }} value={crs} onChange={(e) => setCrs(e.target.value)}>
            {CRS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button className="btn btn-sm" onClick={importMap}>
            Importar
          </button>
        </div>
        <div style={{ color: '#f85149', fontSize: 12 }}>{error}</div>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Estado</th>
              <th>CRS</th>
              <th>Tamaño</th>
              <th>Creado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {maps.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.name}
                  {m.active ? ' ⭐' : ''}
                </td>
                <td title={m.error_message || ''}>{MAP_STATUS_LABEL[m.status] || m.status}</td>
                <td>
                  {m.source_crs || '-'}
                  {m.crs_auto_detected ? ' (auto)' : ''}
                </td>
                <td>{m.size_mb ? `${m.size_mb.toFixed(1)} MB` : '-'}</td>
                <td>{new Date(m.created_at).toLocaleString()}</td>
                <td>
                  {m.status === 'ready' &&
                    (m.active ? (
                      <button className="btn btn-sm btn-danger" onClick={() => deactivateMap(m.id)}>
                        Desactivar
                      </button>
                    ) : (
                      <button className="btn btn-sm" onClick={() => activateMap(m.id)}>
                        Activar
                      </button>
                    ))}{' '}
                  <button className="btn btn-sm" onClick={() => renameMap(m.id, m.name)}>
                    Renombrar
                  </button>{' '}
                  <button className="btn btn-sm btn-danger" onClick={() => deleteMap(m.id)}>
                    Eliminar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
