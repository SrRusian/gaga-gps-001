import type { ReactNode } from 'react';
import { TopBar, TopBarNavButton } from '../../components/TopBar';

export type AdminSectionId = 'dashboard' | 'system';

export interface AdminShellProps {
  connected: boolean;
  userName: string;
  userRoleLabel: string;
  onLogout: () => void;
  section: AdminSectionId;
  onSectionChange?: (s: AdminSectionId) => void;
  // solo el Administrador global tiene la pestana Sistema
  showSystemTab?: boolean;
  // true en la vista Sistema - da padding/scroll al cuerpo
  solid?: boolean;
  children: ReactNode;
}

// Shell del panel Admin (Administrador global + Administrador de Proyecto) - TopBar compartido
// (ver components/TopBar.tsx) con la nav Dashboard/Sistema. El cuerpo lo llena DashboardSection
// (que trae su propia barra lateral) o SystemSection.
export function AdminShell({
  connected,
  userName,
  userRoleLabel,
  onLogout,
  section,
  onSectionChange,
  showSystemTab = false,
  solid = false,
  children,
}: AdminShellProps) {
  return (
    <div className="ad-app">
      <TopBar
        connected={connected}
        userName={userName}
        userRoleLabel={userRoleLabel}
        onLogout={onLogout}
        nav={
          <>
            <TopBarNavButton
              icon="dashboard"
              active={section === 'dashboard'}
              onClick={() => onSectionChange?.('dashboard')}
            >
              Dashboard
            </TopBarNavButton>
            {showSystemTab && (
              <TopBarNavButton
                icon="system"
                active={section === 'system'}
                onClick={() => onSectionChange?.('system')}
              >
                Sistema
              </TopBarNavButton>
            )}
          </>
        }
      />

      <div className={`ad-body${solid ? ' ad-body--solid' : ''}`}>{children}</div>
    </div>
  );
}
