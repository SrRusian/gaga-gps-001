import { Modal } from '@gaga-gps/ui';
import type { ProjectRow } from '../../../types';
import type { GeofencesAdmin } from '../useGeofencesAdmin';
import type { Scope } from '../scope';

export interface GeofencesModalProps {
  open: boolean;
  onClose: () => void;
  scope: Scope;
  scopeLabel: string;
  projects: ProjectRow[];
  admin: GeofencesAdmin;
  onStartCreate: () => void;
  onEdit: (id: number) => void;
}

export function GeofencesModal({
  open,
  onClose,
  scope,
  scopeLabel,
  projects,
  admin,
  onStartCreate,
  onEdit,
}: GeofencesModalProps) {
  return (
    <>
      <Modal size="large" open={open} title={`Geocercas - ${scopeLabel}`} onClose={onClose}>
        <div className="dash-overlay-toolbar">
          <button className="btn btn-sm" onClick={onStartCreate}>
            + Nueva geocerca
          </button>
          <button className="btn btn-sm" onClick={() => admin.exportGeofences('geojson')}>
            Exportar GeoJSON
          </button>
          <button className="btn btn-sm" onClick={() => admin.exportGeofences('kml')}>
            Exportar KML
          </button>
          <button className="btn btn-sm" onClick={admin.openGeoImportModal}>
            Importar (GeoJSON/KML)
          </button>
          <button
            className="btn btn-sm btn-danger"
            disabled={admin.selectedGeofenceIds.size === 0}
            onClick={admin.deleteSelectedGeofences}
          >
            Eliminar seleccionadas{admin.selectedGeofenceIds.size > 0 ? ` (${admin.selectedGeofenceIds.size})` : ''}
          </button>
        </div>
        {admin.scopedGeofences.length === 0 ? (
          <div className="org-empty">Sin geocercas todavía.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 24 }}>
                  <input
                    type="checkbox"
                    title="Seleccionar todas"
                    onChange={(e) =>
                      admin.setSelectedGeofenceIds(
                        e.target.checked ? new Set(admin.scopedGeofences.map((g) => g.id)) : new Set(),
                      )
                    }
                  />
                </th>
                <th>Nombre</th>
                <th>Tipo</th>
                {scope === 'global' && <th>Proyecto</th>}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {admin.scopedGeofences.map((g) => (
                <tr key={g.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={admin.selectedGeofenceIds.has(g.id)}
                      onChange={(e) => admin.toggleGeofenceSelected(g.id, e.target.checked)}
                    />
                  </td>
                  <td>{g.name}</td>
                  <td>{g.type}</td>
                  {scope === 'global' && <td>{projects.find((p) => p.id === g.project_id)?.name ?? '-'}</td>}
                  <td className="org-row-actions">
                    <button className="btn btn-sm" onClick={() => onEdit(g.id)}>
                      Editar
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => admin.deleteGeofenceRow(g)}>
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>

      <Modal open={admin.geoImportModal} title="Importar geocercas (GeoJSON/KML)" onClose={() => admin.setGeoImportModal(false)}>
        {scope === 'global' && (
          <div className="gg-modal-field">
            <label>Proyecto</label>
            <select value={admin.geoImportProjectId} onChange={(e) => admin.setGeoImportProjectId(e.target.value)}>
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
          <label>Archivo (.geojson / .json / .kml)</label>
          <input ref={admin.geoImportFileRef} type="file" accept=".geojson,.json,.kml" />
        </div>
        {admin.importFeedback.text && (
          <div style={{ fontSize: 12, color: admin.importFeedback.ok ? '#4f8ff0' : '#e5484d' }}>
            {admin.importFeedback.text}
          </div>
        )}
        <div className="gg-modal-actions">
          <button className="btn btn-sm" onClick={() => admin.setGeoImportModal(false)}>
            Cancelar
          </button>
          <button className="btn btn-sm" onClick={admin.importGeofences}>
            Importar
          </button>
        </div>
      </Modal>
    </>
  );
}
