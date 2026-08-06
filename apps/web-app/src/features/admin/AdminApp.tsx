import type { ComponentType } from 'react';
import { useState } from 'react';
import './admin.css';
import { DashboardSection } from './sections/DashboardSection';
import { DevicesSection } from './sections/DevicesSection';
import { EquipmentSection } from './sections/EquipmentSection';
import { GeofencesSection } from './sections/GeofencesSection';
import { HistorySection } from './sections/HistorySection';
import { MapsSection } from './sections/MapsSection';
import { ReportsSection } from './sections/ReportsSection';
import { SystemSection } from './sections/SystemSection';
import { UsersSection } from './sections/UsersSection';
import { useAdminAuth } from './useAdminAuth';

const NAV_ITEMS = [
  { id: 'dashboard', label: '📊 Dashboard' },
  { id: 'devices', label: '📱 Dispositivos' },
  { id: 'geofences', label: '🚧 Geocercas' },
  { id: 'equipment', label: '🏗️ Equipo estático' },
  { id: 'maps', label: '🛰️ Mapas' },
  { id: 'history', label: '🕓 Historial' },
  { id: 'reports', label: '📄 Reportes' },
  { id: 'users', label: '👤 Usuarios' },
  { id: 'system', label: '⚙️ Sistema' },
] as const;

type SectionId = (typeof NAV_ITEMS)[number]['id'];

// Cada sección se re-monta al seleccionarla (key={section}) — igual
// que loadSection() volvía a pedir los datos frescos cada vez que
// se entraba a una pestaña en la versión original.
const SECTIONS: Record<SectionId, ComponentType> = {
  dashboard: DashboardSection,
  devices: DevicesSection,
  geofences: GeofencesSection,
  equipment: EquipmentSection,
  maps: MapsSection,
  history: HistorySection,
  reports: ReportsSection,
  users: UsersSection,
  system: SystemSection,
};

// ProtectedRoute (features/auth) ya garantizó una sesión válida con
// rol "admin" antes de montar este componente — no hace falta
// repetir ese chequeo aquí.
export default function AdminApp() {
  const { user, logout } = useAdminAuth();
  const [section, setSection] = useState<SectionId>('dashboard');

  const ActiveSection = SECTIONS[section];

  return (
    <div className="ad-app">
      <div className="ad-header">
        <h1>🛰️ GAGA GPS — Panel Admin</h1>
        <div className="ad-header-right">
          <span>
            {user.name} ({user.role})
          </span>
          <button className="ad-logout-btn" onClick={logout}>
            Salir
          </button>
        </div>
      </div>

      <div className="ad-body">
        <div className="ad-nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={section === item.id ? 'active' : ''}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="ad-content">
          <ActiveSection key={section} />
        </div>
      </div>
    </div>
  );
}
