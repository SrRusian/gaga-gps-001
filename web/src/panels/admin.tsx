import { roleLabel } from '@gaga-gps/client';
import { useState } from 'react';
import './shared/management/admin.css';
// AlertsPanel (dentro del modal de Alertas de DashboardSection) usa clases sup-* definidas ahi -
// project-administrator.tsx NO lo importa a proposito, Admin (global) es el unico pedido
import './shared/monitor/supervisor.css';
import { AdminShell, type AdminSectionId } from './shared/management/components/AdminShell';
import { DashboardSection } from './shared/management/sections/dashboard/DashboardSection';
import { SystemSection } from './shared/management/sections/SystemSection';
import { useAdminAuth } from './shared/management/useAdminAuth';
import { useBackendReachable } from './shared/management/useBackendReachable';

// Administrador global (role=admin) - unico rol con la pestana "Sistema" (config global,
// system_settings). panels/project-administrator.tsx arma el mismo shell SIN esa pestana -
// ni siquiera importa SystemSection, a proposito.
export default function AdminPanel() {
  const { user, logout } = useAdminAuth();
  const [section, setSection] = useState<AdminSectionId>('dashboard');
  const connected = useBackendReachable();

  return (
    <AdminShell
      connected={connected}
      userName={user.name}
      userRoleLabel={roleLabel(user.role)}
      onLogout={logout}
      section={section}
      onSectionChange={setSection}
      showSystemTab
      solid={section === 'system'}
    >
      {section === 'dashboard' ? <DashboardSection key="dashboard" /> : <SystemSection key="system" />}
    </AdminShell>
  );
}
