import { Modal } from '@gaga-gps/ui';
import type { ProjectRow } from '../../../types';
import type { MapsAdmin } from '../useMapsAdmin';
import { CRS_OPTIONS, MAP_STATUS_LABEL } from '../useMapsAdmin';
import type { Scope } from '../scope';

export interface MapsModalProps {
  open: boolean;
  onClose: () => void;
  scope: Scope;
  scopeLabel: string;
  isAdmin: boolean;
  projects: ProjectRow[];
  admin: MapsAdmin;
}

export function MapsModal({ open, onClose, scope, scopeLabel, isAdmin, projects, admin }: MapsModalProps) {
  return (
    <>
      <Modal size="large" open={open} title={`Mapas - ${scopeLabel}`} onClose={onClose}>
        <div className="dash-overlay-toolbar">
          <button className="btn btn-sm" onClick={() => admin.setMapImportModal(true)}>
            + Importar mapa
          </button>
        </div>
        {admin.scopedMapsRows.length === 0 && !admin.mapUpload ? (
          <div className="org-empty">Sin mapas importados todavía.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                {scope === 'global' && <th>Proyecto</th>}
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {admin.mapUpload && (
                <tr>
                  <td>{admin.mapUpload.name}</td>
                  {scope === 'global' && <td>-</td>}
                  <td className="status-uploading">Subiendo… {admin.mapUpload.progress}%</td>
                  <td></td>
                </tr>
              )}
              {admin.scopedMapsRows.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.name}
                    {m.active && <span className="ad-badge">Activo</span>}
                  </td>
                  {scope === 'global' && <td>{projects.find((p) => p.id === m.project_id)?.name ?? '-'}</td>}
                  <td className={`status-${m.status}`} title={m.error_message || ''}>
                    {MAP_STATUS_LABEL[m.status] || m.status}
                  </td>
                  <td className="org-row-actions">
                    {m.status === 'ready' &&
                      (m.active ? (
                        <button className="btn btn-sm btn-danger" onClick={() => admin.deactivateMap(m.id)}>
                          Desactivar
                        </button>
                      ) : (
                        <button className="btn btn-sm" onClick={() => admin.activateMap(m.id)}>
                          Activar
                        </button>
                      ))}
                    <button className="btn btn-sm" onClick={() => admin.openEditMap(m)}>
                      Editar
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => admin.deleteMapRow(m)}>
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>

      <Modal
        open={admin.mapImportModal}
        title="Importar mapa satelital/drone"
        onClose={() => admin.setMapImportModal(false)}
      >
        {scope === 'global' && (
          <div className="gg-modal-field">
            <label>Proyecto</label>
            <select
              value={admin.mapImportForm.projectId}
              onChange={(e) => admin.setMapImportForm({ ...admin.mapImportForm, projectId: e.target.value })}
            >
              <option value="">Selecciona un proyecto…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="gg-modal-field">
          <label>Nombre</label>
          <input
            placeholder="ej. Levantamiento julio 2026"
            value={admin.mapImportForm.name}
            onChange={(e) => admin.setMapImportForm({ ...admin.mapImportForm, name: e.target.value })}
          />
        </div>
        <div className="gg-modal-field">
          <label>Imagen (.tif / .jpg)</label>
          <input ref={admin.imageInputRef} type="file" accept=".tif,.tiff,.jpg,.jpeg" />
        </div>
        <div className="gg-modal-field">
          <label>World file (.tfw / .jpw)</label>
          <input ref={admin.worldInputRef} type="file" accept=".tfw,.jpw,.wld" />
        </div>
        <div className="gg-modal-field">
          <label>Sistema de coordenadas (CRS)</label>
          <select
            value={admin.mapImportForm.crs}
            onChange={(e) => admin.setMapImportForm({ ...admin.mapImportForm, crs: e.target.value })}
          >
            {CRS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        {admin.mapImportError && <div style={{ color: '#e5484d', fontSize: 12 }}>{admin.mapImportError}</div>}
        <div className="gg-modal-actions">
          <button className="btn btn-sm" onClick={() => admin.setMapImportModal(false)}>
            Cancelar
          </button>
          <button className="btn btn-sm" onClick={admin.importMap}>
            Importar
          </button>
        </div>
      </Modal>

      <Modal open={admin.mapEditModal !== null} title="Editar mapa" onClose={() => admin.setMapEditModal(null)}>
        <div className="gg-modal-field">
          <label>Nombre</label>
          <input
            value={admin.mapEditForm.name}
            onChange={(e) => admin.setMapEditForm({ ...admin.mapEditForm, name: e.target.value })}
          />
        </div>
        <div className="gg-modal-field">
          <label>Proyecto</label>
          {isAdmin ? (
            <select
              value={admin.mapEditForm.projectId}
              onChange={(e) => admin.setMapEditForm({ ...admin.mapEditForm, projectId: e.target.value })}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : (
            // solo el admin global puede reasignar el proyecto de un mapa - un Administrador de
            // Proyecto solo administra el suyo, no hay a donde mas moverlo. Ni se renderiza el
            // selector (no solo deshabilitado) - el backend tambien lo rechaza si se fuerza por API.
            <input
              value={projects.find((p) => p.id === admin.mapEditModal?.project_id)?.name ?? 'Sin asignar'}
              disabled
            />
          )}
        </div>
        <div className="gg-modal-actions">
          <button className="btn btn-sm" onClick={() => admin.setMapEditModal(null)}>
            Cancelar
          </button>
          <button className="btn btn-sm" onClick={admin.saveMapEdit}>
            Guardar
          </button>
        </div>
      </Modal>
    </>
  );
}
