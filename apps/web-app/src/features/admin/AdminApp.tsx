import { roleLabel } from '@gaga-gps/client';
import { PanelHeader } from '@gaga-gps/ui';
import type { ComponentType } from 'react';
import { useEffect, useState } from 'react';
import './admin.css';
import { DashboardSection } from './sections/DashboardSection';
import { ReportsSection } from './sections/ReportsSection';
import { SystemSection } from './sections/SystemSection';
import { useAdminAuth } from './useAdminAuth';

const HEALTH_CHECK_INTERVAL_MS = 7000;

/**
 * Admin no tiene un socket propio (a diferencia de Supervisor) -
 * `/health` (público, ya usado por el healthcheck de Docker) sirve
 * igual de bien como señal ligera de "el backend responde", mismo
 * intervalo (~7s) que ya usaba el polling de posiciones en vivo de
 * DashboardSection.
 */
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
  // Dashboard es el único home - mapa grande (Global por defecto) +
  // resumen + Proyectos/Turnos/Dispositivos/Usuarios/Geocercas/Equipo
  // estático/Mapas/Historial como overlays o modos bajo demanda - ver
  // DashboardSection.tsx. Historial (recorrido histórico) ya no es una
  // sección aparte - es un modo de vista dentro de Dashboard, acotado
  // al proyecto elegido (nunca visible en "Global"), para poder
  // filtrarlo por proyecto y reutilizar el mismo mapa/geocercas ya
  // cargados en vez de un mapa e historial de dispositivos sueltos.
  // Visible también para Encargado de Proyecto (con menos opciones -
  // el componente decide eso internamente por rol).
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'reports', label: 'Reportes' },
  // Sistema (estado del backend vía /health) es exclusivo de Admin -
  // el filtro de abajo ya sabía leer "adminOnly", pero ningún item lo
  // declaraba todavía, así que Encargado también lo veía y podía
  // entrar. No hay hueco de datos reales detrás (SystemSection solo
  // pega a /health, público) - esto es puramente el gate de UI que
  // faltaba.
  { id: 'system', label: 'Sistema', adminOnly: true },
] as const;

type SectionId = (typeof NAV_ITEMS)[number]['id'];

// Cada sección se re-monta al seleccionarla (key={section}) - igual
// que loadSection() volvía a pedir los datos frescos cada vez que
// se entraba a una pestaña en la versión original.
const SECTIONS: Record<SectionId, ComponentType> = {
  dashboard: DashboardSection,
  reports: ReportsSection,
  system: SystemSection,
};

// ProtectedRoute (features/auth) ya garantizó una sesión válida con
// rol "admin" o "project_manager" antes de montar este componente -
// este último es "como un mini-admin" pero solo de su proyecto (ver
// filtrado de proyecto en cada sección y gates de "adminOnly" aquí).
export default function AdminApp() {
  const { user, logout } = useAdminAuth();
  const [section, setSection] = useState<SectionId>('dashboard');
  const navItems = NAV_ITEMS.filter((item) => !('adminOnly' in item) || user.role === 'admin');
  const connected = useBackendReachable();

  const ActiveSection = SECTIONS[section];

  // Estilo Traccar: el header flota como una barra semi-transparente
  // encima de todo (el mapa de Dashboard llega hasta los bordes reales
  // de la ventana, position:fixed, detrás incluso del propio header) -
  // ya no hay una barra lateral de navegación fija ni un `.ad-content`
  // con padding compitiendo por espacio con el mapa. Las demás
  // secciones (sin mapa) usan `ad-float-main--solid` para tener un
  // fondo sólido y su propio scroll debajo del header flotante.
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
