import { ConnectionStatusDot } from '@gaga-gps/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { NavIcon } from './NavIcons';

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

// Shell del panel Admin (Administrador global + Administrador de Proyecto) - barra superior solida
// con la nav de secciones + reloj + estado + menu de usuario (Salir). El cuerpo lo llena
// DashboardSection (que trae su propia barra lateral) o SystemSection.
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
    <div className="ad-app">
      <header className="ad-topbar">
        <div className="ad-topbar-brand">
          <NavIcon name="pin" size={22} className="ad-brand-pin" />
          <span className="ad-brand-text">
            <b>GAGA</b>
            <span>GPS</span>
          </span>
        </div>

        <nav className="ad-topbar-nav">
          <button
            className={section === 'dashboard' ? 'active' : ''}
            onClick={() => onSectionChange?.('dashboard')}
          >
            <NavIcon name="dashboard" size={17} />
            Dashboard
          </button>
          {showSystemTab && (
            <button
              className={section === 'system' ? 'active' : ''}
              onClick={() => onSectionChange?.('system')}
            >
              <NavIcon name="system" size={17} />
              Sistema
            </button>
          )}
        </nav>

        <div className="ad-topbar-right">
          <div className="ad-clock">
            <span className="ad-clock-time">{now.toLocaleTimeString('es-MX')}</span>
            <span className="ad-clock-date">
              {now.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })}
            </span>
          </div>

          <div className="ad-conn">
            <ConnectionStatusDot connected={connected} />
            <span>{connected ? 'Servidor en línea' : 'Sin conexión'}</span>
          </div>

          <div className="ad-user" ref={menuRef}>
            <button
              className={`ad-user-btn${menuOpen ? ' open' : ''}`}
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <span className="ad-user-avatar">
                <NavIcon name="users" size={16} />
              </span>
              <span className="ad-user-name">
                {userName} <span className="ad-user-role">({userRoleLabel})</span>
              </span>
              <NavIcon name="chevron" size={15} className="ad-user-caret" />
            </button>
            {menuOpen && (
              <div className="ad-user-menu" role="menu">
                <button className="ad-user-menu-item" role="menuitem" onClick={onLogout}>
                  <NavIcon name="logout" size={16} />
                  Salir
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className={`ad-body${solid ? ' ad-body--solid' : ''}`}>{children}</div>
    </div>
  );
}
