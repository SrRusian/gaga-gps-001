import type { ProjectRow } from '../../../types';
import { NavIcon, type IconName } from '../../../components/NavIcons';
import type { Scope } from '../scope';

export type Overlay = 'projects' | 'shifts' | 'devices' | 'users' | 'geofences' | 'equipment' | 'maps' | null;

export interface DashboardSidebarProps {
  isAdmin: boolean;
  scope: Scope;
  scopeLabel: string;
  selectedProjectId: string;
  projects: ProjectRow[];
  onSelectScope: (value: string) => void;
  onCreateProject: () => void;
  activeOverlay: Overlay;
  onOpenOverlay: (overlay: Overlay) => void;
  historyMode: boolean;
  onEnterHistoryMode: () => void;
  onExitHistoryMode: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

function SidebarItem({
  icon,
  label,
  active,
  collapsed,
  onClick,
}: {
  icon: IconName;
  label: string;
  active?: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`dash-nav-item${active ? ' active' : ''}`}
      onClick={onClick}
      title={collapsed ? label : undefined}
    >
      <NavIcon name={icon} size={18} />
      <span className="dash-nav-label">{label}</span>
    </button>
  );
}

export function DashboardSidebar({
  isAdmin,
  scope,
  scopeLabel,
  selectedProjectId,
  projects,
  onSelectScope,
  onCreateProject,
  activeOverlay,
  onOpenOverlay,
  historyMode,
  onEnterHistoryMode,
  onExitHistoryMode,
  collapsed,
  onToggleCollapse,
}: DashboardSidebarProps) {
  return (
    <aside className={`dash-sidebar${collapsed ? ' dash-sidebar--collapsed' : ''}`}>
      <button
        className="dash-collapse-btn"
        onClick={onToggleCollapse}
        title={collapsed ? 'Expandir menú' : 'Colapsar menú'}
        aria-label={collapsed ? 'Expandir menú' : 'Colapsar menú'}
      >
        <NavIcon name={collapsed ? 'expand' : 'collapse'} size={18} />
      </button>

      <div className="dash-nav">
        <div className="dash-nav-group">
          <span className="dash-nav-group-title">Proyectos</span>
          {isAdmin ? (
            <>
              <select
                className="dash-scope-select"
                value={selectedProjectId}
                onChange={(e) => onSelectScope(e.target.value)}
              >
                <option value="global">Global</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <SidebarItem
                icon="projectNew"
                label="Nuevo proyecto"
                collapsed={collapsed}
                onClick={onCreateProject}
              />
              <SidebarItem
                icon="projects"
                label="Gestionar proyectos"
                active={activeOverlay === 'projects'}
                collapsed={collapsed}
                onClick={() => onOpenOverlay('projects')}
              />
            </>
          ) : (
            <span className="dash-scope-label">{scopeLabel}</span>
          )}
          {typeof scope === 'number' && (
            <SidebarItem
              icon="shifts"
              label="Turnos"
              active={activeOverlay === 'shifts'}
              collapsed={collapsed}
              onClick={() => onOpenOverlay('shifts')}
            />
          )}
        </div>

        <div className="dash-nav-group">
          <span className="dash-nav-group-title">Operación</span>
          <SidebarItem
            icon="devices"
            label="Dispositivos"
            active={activeOverlay === 'devices'}
            collapsed={collapsed}
            onClick={() => onOpenOverlay('devices')}
          />
          <SidebarItem
            icon="users"
            label="Usuarios"
            active={activeOverlay === 'users'}
            collapsed={collapsed}
            onClick={() => onOpenOverlay('users')}
          />
          <SidebarItem
            icon="geofence"
            label="Geocercas"
            active={activeOverlay === 'geofences'}
            collapsed={collapsed}
            onClick={() => onOpenOverlay('geofences')}
          />
          <SidebarItem
            icon="equipment"
            label="Equipo estático"
            active={activeOverlay === 'equipment'}
            collapsed={collapsed}
            onClick={() => onOpenOverlay('equipment')}
          />
          <SidebarItem
            icon="maps"
            label="Mapas"
            active={activeOverlay === 'maps'}
            collapsed={collapsed}
            onClick={() => onOpenOverlay('maps')}
          />
        </div>

        <div className="dash-nav-group dash-nav-group--loose">
          <SidebarItem
            icon="history"
            label="Historial"
            active={historyMode}
            collapsed={collapsed}
            onClick={() => (historyMode ? onExitHistoryMode() : onEnterHistoryMode())}
          />
        </div>
      </div>
    </aside>
  );
}
