import { roleEntries, roleLabel, type AuthUser } from '@gaga-gps/client';
import { Modal } from '@gaga-gps/ui';
import type { ProjectRow } from '../../../types';
import type { UsersAdmin } from '../useUsersAdmin';
import type { Scope } from '../scope';

export interface UsersModalProps {
  open: boolean;
  onClose: () => void;
  scope: Scope;
  scopeLabel: string;
  isAdmin: boolean;
  me: AuthUser;
  projects: ProjectRow[];
  admin: UsersAdmin;
}

export function UsersModal({ open, onClose, scope, scopeLabel, isAdmin, me, projects, admin }: UsersModalProps) {
  return (
    <>
      <Modal size="large" open={open} title={`Usuarios - ${scopeLabel}`} onClose={onClose}>
        <div className="dash-overlay-toolbar">
          <input
            placeholder="Buscar…"
            value={admin.userSearch}
            onChange={(e) => admin.setUserSearch(e.target.value)}
          />
          <button className="btn btn-sm" onClick={admin.openCreateUser}>
            + Nuevo
          </button>
        </div>
        {admin.scopedUsers.length === 0 ? (
          <div className="org-empty">Sin usuarios todavía.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Nombre</th>
                <th>Rol</th>
                {scope === 'global' && <th>Proyecto</th>}
                <th>Activo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {admin.scopedUsers.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.name}</td>
                  <td>{roleLabel(u.role)}</td>
                  {scope === 'global' && (
                    <td>{projects.find((p) => p.id === u.project_id)?.name ?? 'Sin proyecto'}</td>
                  )}
                  <td className={u.active ? 'status-online' : 'status-offline'}>
                    {u.active ? 'Sí' : 'No'}
                  </td>
                  <td className="org-row-actions">
                    <button className="btn btn-sm" onClick={() => admin.openEditUser(u)}>
                      Editar
                    </button>
                    {(isAdmin || u.id !== me.id) && (
                      <button className="btn btn-sm" onClick={() => admin.toggleUserActive(u)}>
                        {u.active ? 'Desactivar' : 'Activar'}
                      </button>
                    )}
                    {(isAdmin || u.id !== me.id) && u.role !== 'admin' && (
                      <button className="btn btn-sm btn-danger" onClick={() => admin.deleteUser(u)}>
                        Eliminar
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>

      <Modal
        open={admin.userModal !== null}
        title={admin.userModal?.user ? 'Editar usuario' : 'Nuevo usuario'}
        onClose={() => admin.setUserModal(null)}
      >
        <div className="gg-modal-field">
          <label>Email</label>
          <input
            value={admin.userForm.email}
            disabled={!isAdmin}
            onChange={(e) => admin.setUserForm({ ...admin.userForm, email: e.target.value })}
          />
        </div>
        <div className="gg-modal-field">
          <label>Nombre</label>
          <input
            value={admin.userForm.name}
            disabled={!isAdmin}
            onChange={(e) => admin.setUserForm({ ...admin.userForm, name: e.target.value })}
          />
        </div>
        {!admin.userModal?.user && (
          <div className="gg-modal-field">
            <label>Contraseña</label>
            <input
              type="password"
              value={admin.userForm.password}
              onChange={(e) => admin.setUserForm({ ...admin.userForm, password: e.target.value })}
            />
          </div>
        )}
        <div className="gg-modal-field">
          <label>Rol</label>
          <select
            value={admin.userForm.role}
            onChange={(e) => {
              const role = e.target.value;
              admin.setUserForm({
                ...admin.userForm,
                role,
                projectId: role === 'admin' ? '' : admin.userForm.projectId,
              });
            }}
          >
            {roleEntries()
              .filter(([value]) => isAdmin || value !== 'admin')
              .map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
          </select>
        </div>
        {isAdmin && (admin.userModal?.user || scope === 'global') && (
          <div className="gg-modal-field">
            <label>Proyecto</label>
            <select
              value={admin.userForm.projectId}
              disabled={admin.userForm.role === 'admin'}
              onChange={(e) => admin.setUserForm({ ...admin.userForm, projectId: e.target.value })}
            >
              <option value="">Sin proyecto (solo admin)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {admin.userForm.role === 'admin' && (
              <span className="dash-hint">
                Un Admin siempre tiene alcance global - no se le puede asignar un proyecto.
              </span>
            )}
          </div>
        )}
        <div className="gg-modal-actions">
          <button className="btn btn-sm" onClick={() => admin.setUserModal(null)}>
            Cancelar
          </button>
          <button className="btn btn-sm" onClick={admin.saveUser}>
            Guardar
          </button>
        </div>
      </Modal>
    </>
  );
}
