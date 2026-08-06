import { useEffect, useState } from 'react';
import { adminApi } from '../api';
import type { EquipmentRow } from '../types';

export function EquipmentSection() {
  const [equipment, setEquipment] = useState<EquipmentRow[]>([]);
  const [form, setForm] = useState({ name: '', type: '', lat: '', lon: '', swing: '', safety: '' });

  async function loadEquipment() {
    setEquipment(await adminApi.get<EquipmentRow[]>('/api/equipment'));
  }

  useEffect(() => {
    loadEquipment();
  }, []);

  async function createEquipment() {
    const latitude = parseFloat(form.lat);
    const longitude = parseFloat(form.lon);
    const swingRadius = parseFloat(form.swing);
    const safetyRadius = parseFloat(form.safety);
    if (
      !form.name ||
      !form.type ||
      isNaN(latitude) ||
      isNaN(longitude) ||
      !swingRadius ||
      !safetyRadius
    ) {
      alert('Complete todos los campos');
      return;
    }
    await adminApi.post('/api/equipment', {
      name: form.name,
      type: form.type,
      latitude,
      longitude,
      swingRadius,
      safetyRadius,
    });
    setForm({ name: '', type: '', lat: '', lon: '', swing: '', safety: '' });
    loadEquipment();
  }

  async function deleteEquipment(id: number) {
    if (!confirm('¿Eliminar equipo?')) return;
    await adminApi.delete(`/api/equipment/${id}`);
    loadEquipment();
  }

  return (
    <>
      <div className="card">
        <h3>Registrar equipo estático</h3>
        <div className="form-row">
          <input
            placeholder="Nombre"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            placeholder="Tipo (pala/excavadora)"
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value })}
          />
          <input
            placeholder="Lat"
            type="number"
            step="any"
            value={form.lat}
            onChange={(e) => setForm({ ...form, lat: e.target.value })}
          />
          <input
            placeholder="Lon"
            type="number"
            step="any"
            value={form.lon}
            onChange={(e) => setForm({ ...form, lon: e.target.value })}
          />
          <input
            placeholder="Radio de giro (m)"
            type="number"
            value={form.swing}
            onChange={(e) => setForm({ ...form, swing: e.target.value })}
          />
          <input
            placeholder="Radio seguridad (m)"
            type="number"
            value={form.safety}
            onChange={(e) => setForm({ ...form, safety: e.target.value })}
          />
          <button className="btn btn-sm" onClick={createEquipment}>
            Agregar
          </button>
        </div>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Tipo</th>
              <th>Radio giro</th>
              <th>Radio seguridad</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {equipment.map((eq) => (
              <tr key={eq.id}>
                <td>{eq.name}</td>
                <td>{eq.type}</td>
                <td>{eq.swing_radius}</td>
                <td>{eq.safety_radius}</td>
                <td>{eq.status}</td>
                <td>
                  <button className="btn btn-sm btn-danger" onClick={() => deleteEquipment(eq.id)}>
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
