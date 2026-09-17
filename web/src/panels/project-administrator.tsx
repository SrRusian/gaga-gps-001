import { roleLabel } from '@gaga-gps/client';
import './shared/management/admin.css';
import { AdminShell } from './shared/management/components/AdminShell';
import { DashboardSection } from './shared/management/sections/dashboard/DashboardSection';
import { useAdminAuth } from './shared/management/useAdminAuth';
import { useBackendReachable } from './shared/management/useBackendReachable';

// Administrador de Proyecto (role=project_administrator) - mismo Dashboard que panels/admin, pero
// SIN la pestana "Sistema" (config global, exclusiva del admin) - este archivo nunca importa
// SystemSection. Full CRUD dentro de su propio proyecto via DashboardSection.
export default function ProjectAdministratorPanel() {
  const { user, logout } = useAdminAuth();
  const connected = useBackendReachable();

  return (
    <AdminShell
      connected={connected}
      userName={user.name}
      userRoleLabel={roleLabel(user.role)}
      onLogout={logout}
      section="dashboard"
    >
      <DashboardSection />
    </AdminShell>
  );
}
