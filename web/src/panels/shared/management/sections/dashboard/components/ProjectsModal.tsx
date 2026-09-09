import { Modal } from '@gaga-gps/ui';
import type { ProjectsAdmin } from '../useProjectsAdmin';

export interface ProjectsModalProps {
  open: boolean;
  onClose: () => void;
  admin: ProjectsAdmin;
  onSelectScope: (scopeValue: string) => void;
}

export function ProjectsModal({ open, onClose, admin, onSelectScope }: ProjectsModalProps) {
  return (
    <>
      <Modal size="large" open={open} title="Proyectos" onClose={onClose}>
        <div className="dash-overlay-toolbar">
          <input
            placeholder="Buscar proyecto…"
            value={admin.projectSearch}
            onChange={(e) => admin.setProjectSearch(e.target.value)}
          />
          <button className="btn btn-sm" onClick={admin.openCreateProject}>
            + Nuevo proyecto
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Activo</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr className="org-row" onClick={() => onSelectScope('global')}>
              <td>Global</td>
              <td>-</td>
              <td></td>
            </tr>
            {admin.filteredProjects.map((p) => (
              <tr key={p.id} className="org-row" onClick={() => onSelectScope(String(p.id))}>
                <td>{p.name}</td>
                <td className={p.active ? 'status-online' : 'status-offline'}>{p.active ? 'Sí' : 'No'}</td>
                <td className="org-row-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="btn btn-sm" onClick={() => admin.openEditProject(p)}>
                    Editar
                  </button>
                  <button className="btn btn-sm" onClick={() => admin.toggleProjectActive(p)}>
                    {p.active ? 'Desactivar' : 'Activar'}
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => admin.deleteProject(p)}>
                    Eliminar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Modal>

      <Modal
        open={admin.projectModal !== null}
        title={admin.projectModal?.project ? 'Editar proyecto' : 'Nuevo proyecto'}
        onClose={() => admin.setProjectModal(null)}
      >
        <div className="gg-modal-field">
          <label>Nombre</label>
          <input
            placeholder="ej. Mina Colima Norte"
            value={admin.projectForm.name}
            onChange={(e) => admin.setProjectForm({ name: e.target.value })}
          />
        </div>
        <div className="gg-modal-actions">
          <button className="btn btn-sm" onClick={() => admin.setProjectModal(null)}>
            Cancelar
          </button>
          <button className="btn btn-sm" onClick={admin.saveProject}>
            Guardar
          </button>
        </div>
      </Modal>
    </>
  );
}
