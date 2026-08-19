import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { ConnectionStatusDot } from './ConnectionStatusDot';

export interface PanelHeaderProps {
  connected: boolean;
  userName: string;
  userRoleLabel: string;
  onLogout: () => void;
  children?: ReactNode;
}

export function PanelHeader({ connected, userName, userRoleLabel, onLogout, children }: PanelHeaderProps) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="gg-panel-header">
      <div className="gg-panel-header-left">
        <h1>GAGA GPS</h1>
        {children}
      </div>
      <div className="gg-panel-header-status">
        <span className="gg-panel-header-clock">{now.toLocaleTimeString('es-MX')}</span>
        <div className="gg-panel-header-connection">
          <ConnectionStatusDot connected={connected} />
          <span>{connected ? 'Conectado' : 'Desconectado'}</span>
        </div>
        <span className="gg-panel-header-user">
          {userName} <span className="gg-panel-header-role">({userRoleLabel})</span>
        </span>
        <button className="gg-panel-header-logout" onClick={onLogout}>
          Salir
        </button>
      </div>
    </header>
  );
}
