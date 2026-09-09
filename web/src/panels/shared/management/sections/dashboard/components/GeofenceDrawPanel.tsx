import type { ProjectRow } from '../../../types';
import type { GeofencesAdmin } from '../useGeofencesAdmin';
import { SHAPE_HINTS, type GeofenceShape } from '../useGeofencesAdmin';
import type { Scope } from '../scope';

export interface GeofenceDrawPanelProps {
  scope: Scope;
  projects: ProjectRow[];
  geofence: GeofencesAdmin;
}

export function GeofenceDrawPanel({ scope, projects, geofence }: GeofenceDrawPanelProps) {
  if (!geofence.showGeoPanel) return null;
  const g = geofence;

  return (
    <div className="dash-float-panel dash-glass">
      <div className="dash-float-panel-header">
        <h4>{g.geoEditingId != null ? 'Editar geocerca' : 'Nueva geocerca'}</h4>
        <button className="gg-modal-close" onClick={g.closeGeoPanel} aria-label="Cerrar">
          X
        </button>
      </div>
      <div className="dash-float-panel-body">
        <div className="dash-field-group">
          <span className="dash-field-group-title">Forma</span>
          <select
            value={g.geoShape}
            onChange={(e) => g.onShapeChange(e.target.value as GeofenceShape)}
            disabled={g.geoEditingId != null}
          >
            {g.geoShape === 'circle' && <option value="circle">Círculo (heredado)</option>}
            <option value="polygon">Polígono</option>
            <option value="polyline">Línea / corredor</option>
          </select>
          <span className="dash-hint">{SHAPE_HINTS[g.geoShape]}</span>
        </div>

        {scope === 'global' && g.geoEditingId == null && (
          <div className="dash-field-group">
            <span className="dash-field-group-title">Proyecto</span>
            <select value={g.geoTargetProjectId} onChange={(e) => g.setGeoTargetProjectId(e.target.value)}>
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
            value={g.geofenceForm.name}
            onChange={(e) => g.setGeofenceForm({ ...g.geofenceForm, name: e.target.value })}
          />
          <select
            value={g.geofenceForm.type}
            onChange={(e) => g.setGeofenceForm({ ...g.geofenceForm, type: e.target.value })}
          >
            <option value="forbidden">Zona prohibida (negro)</option>
            <option value="danger">Peligro (rojo)</option>
            <option value="warning">Advertencia (amarillo)</option>
            <option value="authorized_route">Ruta autorizada (naranja)</option>
            <option value="allowed">Zona permitida (verde)</option>
            <option value="parking">Estacionamiento (azul)</option>
            <option value="discharge">Descarga (café)</option>
            <option value="carga">Carga (cyan)</option>
            <option value="maintenance">Mantenimiento (morado)</option>
          </select>
        </div>

        {g.geoShape === 'polygon' && (
          <div className="dash-field-group">
            <span className="dash-field-group-title">Relleno</span>
            <select
              value={g.geofenceForm.filled ? 'filled' : 'unfilled'}
              onChange={(e) =>
                g.setGeofenceForm({ ...g.geofenceForm, filled: e.target.value === 'filled' })
              }
            >
              <option value="filled">Con relleno (zona completa)</option>
              <option value="unfilled">Sin relleno (alerta solo al cruzar el borde)</option>
            </select>
            <span className="dash-hint">
              {g.geofenceForm.filled
                ? 'La alerta se dispara mientras el vehículo esté dentro de la zona.'
                : 'La alerta se dispara al acercarse a la línea del borde, sin importar si está adentro o afuera. La acción/severidad la sigue decidiendo el tipo elegido arriba.'}
            </span>
          </div>
        )}

        {g.geoShape === 'polyline' && (
          <div className="dash-field-group">
            <span className="dash-field-group-title">Comportamiento</span>
            <select
              value={g.geofenceForm.stayInside ? 'stay_inside' : 'keep_away'}
              onChange={(e) =>
                g.setGeofenceForm({ ...g.geofenceForm, stayInside: e.target.value === 'stay_inside' })
              }
            >
              <option value="stay_inside">Debe quedarse dentro del ancho</option>
              <option value="keep_away">No debe tocarla</option>
            </select>
            <span className="dash-hint">
              {g.geofenceForm.stayInside
                ? 'La alerta se dispara si el vehículo se ALEJA más del ancho indicado (ej. Ruta autorizada).'
                : 'La alerta se dispara si el vehículo se ACERCA al ancho indicado (ej. una línea que no debe cruzarse).'}
            </span>
          </div>
        )}

        {g.geoShape === 'circle' && (
          <div className="dash-field-group">
            <span className="dash-field-group-title">Ubicación y radio</span>
            <input placeholder="Lat" readOnly value={g.geoSelectedCenter ? g.geoSelectedCenter.lat.toFixed(6) : ''} />
            <input placeholder="Lon" readOnly value={g.geoSelectedCenter ? g.geoSelectedCenter.lon.toFixed(6) : ''} />
            <input
              placeholder="Radio (m)"
              type="number"
              value={g.geofenceForm.radius}
              onChange={(e) => g.setGeofenceForm({ ...g.geofenceForm, radius: e.target.value })}
            />
            {g.geoSelectedCenter && (
              <span className="dash-hint">Vista previa en morado sobre el mapa - se actualiza mientras escribes.</span>
            )}
          </div>
        )}
        {(g.geoShape === 'polyline' || (g.geoShape === 'polygon' && !g.geofenceForm.filled)) && (
          <div className="dash-field-group">
            <span className="dash-field-group-title">Ancho de detección (m)</span>
            <input
              placeholder="Ancho (m)"
              type="number"
              value={g.geofenceForm.corridorWidth}
              onChange={(e) => g.setGeofenceForm({ ...g.geofenceForm, corridorWidth: e.target.value })}
            />
            <span className="dash-hint">
              {g.geoShape === 'polyline'
                ? 'Vista previa en morado sobre el mapa - se actualiza mientras escribes o mueves un vértice.'
                : 'Qué tan cerca del borde del polígono cuenta como haber cruzado la línea.'}
            </span>
          </div>
        )}
        <div className="dash-float-panel-actions">
          <button className="btn btn-sm" onClick={g.saveGeofenceRow}>
            {g.geoEditingId != null ? 'Guardar cambios' : 'Crear'}
          </button>
          {g.geoShape !== 'circle' && g.geoEditingId == null && (
            <>
              <button className="btn btn-sm" onClick={g.finishDrawing}>
                Finalizar trazado
              </button>
              <button className="btn btn-sm btn-danger" onClick={g.cancelDrawing}>
                Cancelar dibujo
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
