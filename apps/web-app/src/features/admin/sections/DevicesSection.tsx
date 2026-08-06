import { useEffect, useState } from 'react';
import { ApiError, adminApi } from '../api';
import type { DeviceRow } from '../types';

export function DevicesSection() {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [uniqueId, setUniqueId] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState('');

  async function loadDevices() {
    setDevices(await adminApi.get<DeviceRow[]>('/api/devices'));
  }

  useEffect(() => {
    loadDevices();
  }, []);

  async function createDevice() {
    if (!uniqueId || !name) {
      alert('uniqueId y name son requeridos');
      return;
    }
    await adminApi.post('/api/devices', { uniqueId, name, type: type || 'vehicle' });
    setUniqueId('');
    setName('');
    setType('');
    loadDevices();
  }

  async function deleteDevice(id: number) {
    if (!confirm('¿Eliminar dispositivo?')) return;
    try {
      await adminApi.delete(`/api/devices/${id}`);
      loadDevices();
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.body as { code?: string })?.code === 'DEVICE_HAS_POSITIONS'
      ) {
        if (
          confirm(
            `${err.message}\n\n¿Eliminar también ese historial? Esta acción no se puede deshacer.`,
          )
        ) {
          await adminApi.delete(`/api/devices/${id}?force=true`);
          loadDevices();
        }
      } else {
        alert(err instanceof Error ? err.message : 'Error eliminando dispositivo');
      }
    }
  }

  return (
    <>
      <div className="card">
        <h3>Registrar dispositivo</h3>
        <div className="form-row">
          <input
            placeholder="ID único (Traccar Client)"
            value={uniqueId}
            onChange={(e) => setUniqueId(e.target.value)}
          />
          <input placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            placeholder="Tipo (vehicle)"
            value={type}
            onChange={(e) => setType(e.target.value)}
          />
          <button className="btn btn-sm" onClick={createDevice}>
            Agregar
          </button>
        </div>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Nombre</th>
              <th>Tipo</th>
              <th>Estado</th>
              <th>Última actualización</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>{d.unique_id}</td>
                <td>{d.name}</td>
                <td>{d.type}</td>
                <td className={`status-${d.status}`}>{d.status}</td>
                <td>{d.last_update ? new Date(d.last_update).toLocaleString() : '-'}</td>
                <td>
                  <button className="btn btn-sm btn-danger" onClick={() => deleteDevice(d.id)}>
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
