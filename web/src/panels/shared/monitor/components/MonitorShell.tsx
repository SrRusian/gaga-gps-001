import type { ReactNode } from 'react';
import { TopBar } from '../../components/TopBar';

export interface MonitorShellProps {
  connected: boolean;
  userName: string;
  userRoleLabel: string;
  onLogout: () => void;
  children: ReactNode;
}

// Shell de Supervisor y Encargado de Proyecto - mismo TopBar que AdminShell.tsx (sin nav de
// secciones, este rol no tiene). El cuerpo (barra lateral + mapa) lo arma cada index.tsx, ver
// panels/supervisor.tsx y panels/project-manager.tsx.
export function MonitorShell({ connected, userName, userRoleLabel, onLogout, children }: MonitorShellProps) {
  return (
    <div className="sup-app sup-tokens">
      <TopBar connected={connected} userName={userName} userRoleLabel={userRoleLabel} onLogout={onLogout} />
      <div className="sup-body">{children}</div>
    </div>
  );
}
