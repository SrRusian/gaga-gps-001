import { ConnectionStatusDot } from '@gaga-gps/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { NavIcon, type IconName } from './NavIcons';
import './topbar.css';

export interface TopBarProps {
  connected: boolean;
  userName: string;
  userRoleLabel: string;
  onLogout: () => void;
  // nav de secciones - solo Admin la usa (Dashboard/Sistema); Supervisor/Encargado no tienen
  nav?: ReactNode;
}

// Barra superior solida compartida por los shells de Admin y Supervisor/Encargado (ver
// AdminShell.tsx y MonitorShell.tsx) - marca, nav opcional, reloj, estado del backend y menu
// de usuario con Salir. Reemplaza al viejo PanelHeader (eliminado, ver git log).
export function TopBar({ connected, userName, userRoleLabel, onLogout, nav }: TopBarProps) {
  const [now, setNow] = useState(() => new Date());
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  return (
    <header className="gg-topbar">
      <div className="gg-topbar-brand">
        <NavIcon name="pin" size={22} className="gg-topbar-brand-pin" />
        <span className="gg-topbar-brand-text">
          <b>GAGA</b>
          <span>GPS</span>
        </span>
      </div>

      {nav && <nav className="gg-topbar-nav">{nav}</nav>}

      <div className="gg-topbar-right">
        <div className="gg-topbar-clock">
          <span className="gg-topbar-clock-time">{now.toLocaleTimeString('es-MX')}</span>
          <span className="gg-topbar-clock-date">
            {now.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })}
          </span>
        </div>

        <div className="gg-topbar-conn">
          <ConnectionStatusDot connected={connected} />
          <span>{connected ? 'Servidor en línea' : 'Sin conexión'}</span>
        </div>

        <div className="gg-topbar-user" ref={menuRef}>
          <button
            className={`gg-topbar-user-btn${menuOpen ? ' open' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span className="gg-topbar-user-avatar">
              <NavIcon name="users" size={16} />
            </span>
            <span className="gg-topbar-user-name">
              {userName} <span className="gg-topbar-user-role">({userRoleLabel})</span>
            </span>
            <NavIcon name="chevron" size={15} className="gg-topbar-user-caret" />
          </button>
          {menuOpen && (
            <div className="gg-topbar-user-menu" role="menu">
              <button className="gg-topbar-user-menu-item" role="menuitem" onClick={onLogout}>
                <NavIcon name="logout" size={16} />
                Salir
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export interface TopBarNavButtonProps {
  icon: IconName;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}

// Boton de la nav de secciones del TopBar (hoy solo lo usa AdminShell para Dashboard/Sistema)
export function TopBarNavButton({ icon, active, onClick, children }: TopBarNavButtonProps) {
  return (
    <button className={active ? 'active' : ''} onClick={onClick}>
      <NavIcon name={icon} size={17} />
      {children}
    </button>
  );
}
