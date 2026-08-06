import { useEffect, useState } from 'react';
import { adminApi } from '../api';
import type { DeviceRow, EquipmentRow, GeofenceRow } from '../types';

export function DashboardSection() {
  const [counts, setCounts] = useState({ devices: 0, online: 0, geofences: 0, equipment: 0 });

  useEffect(() => {
    (async () => {
      try {
        const [devices, geofences, equipment] = await Promise.all([
          adminApi.get<DeviceRow[]>('/api/devices'),
          adminApi.get<GeofenceRow[]>('/api/geofences'),
          adminApi.get<EquipmentRow[]>('/api/equipment'),
        ]);
        setCounts({
          devices: devices.length,
          online: devices.filter((d) => d.status === 'online').length,
          geofences: geofences.length,
          equipment: equipment.length,
        });
      } catch (err) {
        console.error(err);
      }
    })();
  }, []);

  return (
    <div className="card">
      <div className="metric">
        <div className="value">{counts.devices}</div>
        <div className="label">Dispositivos</div>
      </div>
      <div className="metric">
        <div className="value">{counts.online}</div>
        <div className="label">En línea</div>
      </div>
      <div className="metric">
        <div className="value">{counts.geofences}</div>
        <div className="label">Geocercas</div>
      </div>
      <div className="metric">
        <div className="value">{counts.equipment}</div>
        <div className="label">Equipo estático</div>
      </div>
    </div>
  );
}
