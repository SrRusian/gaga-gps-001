import { roleLabel } from '@gaga-gps/client';
import { PanelHeader } from '@gaga-gps/ui';
import { useState } from 'react';
import './shared/management/admin.css';
import { DashboardSection } from './shared/management/sections/dashboard/DashboardSection';
import { SystemSection } from './shared/management/sections/SystemSection';
import { useAdminAuth } from './shared/management/useAdminAuth';
import { useBackendReachable } from './shared/management/useBackendReachable';

type SectionId = 'dashboard' | 'system';

// Administrador global (role=admin) - unico rol con la pestana "Sistema" (config global,
// system_settings). panels/project-administrator.tsx arma el mismo layout SIN esa pestana -
// ni siquiera importa SystemSection, a proposito (antes era un filtro de rol enterrado en
// NAV_ITEMS.filter(...), ahora es literal: este archivo la importa, el otro no).
export default function AdminPanel() {
  const { user, logout } = useAdminAuth();
  const [section, setSection] = useState<SectionId>('dashboard');
  const connected = useBackendReachable();

  return (
    <div className="ad-app ad-app--floating">
      <PanelHeader connected={connected} userName={user.name} userRoleLabel={roleLabel(user.role)} onLogout={logout}>
        <nav className="ad-float-nav">
          <button className={section === 'dashboard' ? 'active' : ''} onClick={() => setSection('dashboard')}>
            Dashboard
          </button>
          <button className={section === 'system' ? 'active' : ''} onClick={() => setSection('system')}>
            Sistema
          </button>
        </nav>
      </PanelHeader>

      <main className={`ad-float-main${section !== 'dashboard' ? ' ad-float-main--solid' : ''}`}>
        {section === 'dashboard' ? <DashboardSection key="dashboard" /> : <SystemSection key="system" />}
      </main>
    </div>
  );
}
