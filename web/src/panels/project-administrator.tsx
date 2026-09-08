import { roleLabel } from '@gaga-gps/client';
import { PanelHeader } from '@gaga-gps/ui';
import './shared/management/admin.css';
import { DashboardSection } from './shared/management/sections/dashboard/DashboardSection';
import { useAdminAuth } from './shared/management/useAdminAuth';
import { useBackendReachable } from './shared/management/useBackendReachable';

// Administrador de Proyecto (role=project_administrator) - mismo Dashboard que panels/admin, pero
// SIN la pestana "Sistema" (config global, exclusiva del admin) - este archivo nunca importa
// SystemSection, por eso no hay ni boton de nav para ella. Full CRUD dentro de su propio proyecto
// via DashboardSection (que ya gatea internamente lo que es admin-only, ej. reasignar el proyecto
// de un mapa).
export default function ProjectAdministratorPanel() {
  const { user, logout } = useAdminAuth();
  const connected = useBackendReachable();

  return (
    <div className="ad-app ad-app--floating">
      <PanelHeader connected={connected} userName={user.name} userRoleLabel={roleLabel(user.role)} onLogout={logout} />

      <main className="ad-float-main">
        <DashboardSection />
      </main>
    </div>
  );
}
