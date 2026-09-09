import type { ProjectRow } from '../../../types';
import type { Scope } from '../scope';

export type Overlay = 'projects' | 'shifts' | 'devices' | 'users' | 'geofences' | 'equipment' | 'maps' | null;

export interface DashboardToolbarProps {
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
}

export function DashboardToolbar({
  isAdmin,
  scope,
  scopeLabel,
  selectedProjectId,
  projects,
  onSelectScope,
  onCreateProject,
  onOpenOverlay,
  historyMode,
  onEnterHistoryMode,
  onExitHistoryMode,
}: DashboardToolbarProps) {
  return (
    <div className="dash-left-stack">
      <div className="dash-toolbar dash-glass">
        <div className="dash-scope-picker">
          {isAdmin ? (
            <>
              <select value={selectedProjectId} onChange={(e) => onSelectScope(e.target.value)}>
                <option value="global">Global</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button className="btn btn-sm" onClick={onCreateProject}>
                + Proyecto
              </button>
              <button className="btn btn-sm" onClick={() => onOpenOverlay('projects')}>
                Gestionar proyectos
              </button>
            </>
          ) : (
            <span className="dash-scope-label">{scopeLabel}</span>
          )}
        </div>

        <div className="dash-actions">
          {typeof scope === 'number' && (
            <button className="btn btn-sm" onClick={() => onOpenOverlay('shifts')}>
              Turnos
            </button>
          )}
          <button className="btn btn-sm" onClick={() => onOpenOverlay('devices')}>
            Dispositivos
          </button>
          <button className="btn btn-sm" onClick={() => onOpenOverlay('users')}>
            Usuarios
          </button>
          <button className="btn btn-sm" onClick={() => onOpenOverlay('geofences')}>
            Geocercas
          </button>
          <button className="btn btn-sm" onClick={() => onOpenOverlay('equipment')}>
            Equipo estático
          </button>
          <button className="btn btn-sm" onClick={() => onOpenOverlay('maps')}>
            Mapas
          </button>
        </div>

        <div className="dash-tools">
          <button
            className={`btn btn-sm${historyMode ? ' active' : ''}`}
            onClick={() => (historyMode ? onExitHistoryMode() : onEnterHistoryMode())}
          >
            {historyMode ? 'Salir del historial' : 'Historial'}
          </button>
        </div>
      </div>
    </div>
  );
}
