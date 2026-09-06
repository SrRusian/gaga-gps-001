import { roleLabel } from '@gaga-gps/client';
import { PanelHeader } from '@gaga-gps/ui';
import type { ComponentType } from 'react';
import { useEffect, useState } from 'react';
import './admin.css';
import { DashboardSection } from './sections/DashboardSection';
import { SystemSection } from './sections/SystemSection';
import { useAdminAuth } from './useAdminAuth';

const HEALTH_CHECK_INTERVAL_MS = 7000;

function useBackendReachable(): boolean {
  const [reachable, setReachable] = useState(true);
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch('/health');
        if (!cancelled) setReachable(res.ok);
      } catch {
        if (!cancelled) setReachable(false);
      }
    }
    check();
    const interval = setInterval(check, HEALTH_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);
  return reachable;
}

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'system', label: 'Sistema', adminOnly: true },
] as const;

type SectionId = (typeof NAV_ITEMS)[number]['id'];

const SECTIONS: Record<SectionId, ComponentType> = {
  dashboard: DashboardSection,
  system: SystemSection,
};

export default function AdminApp() {
  const { user, logout } = useAdminAuth();
  const [section, setSection] = useState<SectionId>('dashboard');
  const navItems = NAV_ITEMS.filter((item) => !('adminOnly' in item) || user.role === 'admin');
  const connected = useBackendReachable();

  const ActiveSection = SECTIONS[section];

  return (
    <div className="ad-app ad-app--floating">
      <PanelHeader
        connected={connected}
        userName={user.name}
        userRoleLabel={roleLabel(user.role)}
        onLogout={logout}
      >
        <nav className="ad-float-nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={section === item.id ? 'active' : ''}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </PanelHeader>

      <main className={`ad-float-main${section !== 'dashboard' ? ' ad-float-main--solid' : ''}`}>
        <ActiveSection key={section} />
      </main>
    </div>
  );
}
