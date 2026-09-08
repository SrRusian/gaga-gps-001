import type { ProjectRow } from '../../../types';
import type { EquipmentAdmin } from '../useEquipmentAdmin';
import type { Scope } from '../scope';

export interface EquipmentPlacePanelProps {
  scope: Scope;
  projects: ProjectRow[];
  equipment: EquipmentAdmin;
}

export function EquipmentPlacePanel({ scope, projects, equipment }: EquipmentPlacePanelProps) {
  if (!equipment.showEquipPanel) return null;
  const eq = equipment;

  return (
    <div className="dash-float-panel dash-glass">
      <div className="dash-float-panel-header">
        <h4>{eq.equipmentEditingId != null ? 'Editar equipo estático' : 'Nuevo equipo estático'}</h4>
        <button className="gg-modal-close" onClick={eq.closeEquipPanel} aria-label="Cerrar">
          X
        </button>
      </div>
      <div className="dash-float-panel-body">
        {scope === 'global' && eq.equipmentEditingId == null && (
          <div className="dash-field-group">
            <span className="dash-field-group-title">Proyecto</span>
            <select value={eq.equipTargetProjectId} onChange={(e) => eq.setEquipTargetProjectId(e.target.value)}>
              <option value="">Selecciona un proyecto…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="dash-field-group">
          <span className="dash-field-group-title">Datos</span>
          <input
            placeholder="Nombre"
            value={eq.equipmentForm.name}
            onChange={(e) => eq.setEquipmentForm({ ...eq.equipmentForm, name: e.target.value })}
          />
          <input
            placeholder="Tipo (pala/excavadora)"
            value={eq.equipmentForm.type}
            onChange={(e) => eq.setEquipmentForm({ ...eq.equipmentForm, type: e.target.value })}
          />
        </div>

        <div className="dash-field-group">
          <span className="dash-field-group-title">Dispositivo vinculado</span>
          <select
            value={eq.equipmentForm.linkedDeviceId}
            onChange={(e) => eq.setEquipmentForm({ ...eq.equipmentForm, linkedDeviceId: e.target.value })}
          >
            <option value="">Sin vincular</option>
            {eq.linkableDevices.map((d) => (
              <option key={d.unique_id} value={d.unique_id}>
                {d.name} ({d.unique_id})
              </option>
            ))}
          </select>
          <span className="dash-hint">
            La tableta montada en esta máquina - cuando el operador inicie turno ahí, el equipo pasa a "En
            operación" solo, y el operador se ve a sí mismo como este equipo en vez de como vehículo.
          </span>
        </div>

        <div className="dash-field-group">
          <span className="dash-field-group-title">Ubicación y radios</span>
          <button
            className={`btn btn-sm${eq.placingEquipment ? ' active' : ''}`}
            onClick={() => eq.setPlacingEquipment((v) => !v)}
          >
            {eq.placingEquipment
              ? 'Clic en el mapa…'
              : eq.equipmentPosition
                ? 'Reubicar (clic en el mapa)'
                : 'Colocar en mapa'}
          </button>
          <input placeholder="Lat" readOnly value={eq.equipmentPosition ? eq.equipmentPosition.lat.toFixed(6) : ''} />
          <input placeholder="Lon" readOnly value={eq.equipmentPosition ? eq.equipmentPosition.lon.toFixed(6) : ''} />
          <input
            placeholder="Radio de giro (m)"
            type="number"
            value={eq.equipmentForm.swingRadius}
            onChange={(e) => eq.setEquipmentForm({ ...eq.equipmentForm, swingRadius: e.target.value })}
          />
          <input
            placeholder="Radio seguridad (m)"
            type="number"
            value={eq.equipmentForm.safetyRadius}
            onChange={(e) => eq.setEquipmentForm({ ...eq.equipmentForm, safetyRadius: e.target.value })}
          />
          {eq.equipmentPosition && (
            <span className="dash-hint">
              Vista previa en el mapa (núcleo amarillo = radio de giro, anillo punteado azul = radio de
              seguridad) - se actualiza mientras escribes. Arrastra el marcador para mover el equipo.
            </span>
          )}
        </div>

        <div className="dash-float-panel-actions">
          <button className="btn btn-sm" onClick={eq.saveEquipmentRow}>
            {eq.equipmentEditingId != null ? 'Guardar cambios' : 'Agregar'}
          </button>
        </div>
      </div>
    </div>
  );
}
