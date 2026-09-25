import { Modal } from '@gaga-gps/ui';
import type { VehicleTypesAdmin } from '../useVehicleTypesAdmin';

export interface VehicleTypesModalProps {
  open: boolean;
  onClose: () => void;
  admin: VehicleTypesAdmin;
}

export function VehicleTypesModal({ open, onClose, admin }: VehicleTypesModalProps) {
  return (
    <>
      <Modal open={open} title="Tipos de vehículo" onClose={onClose}>
        <p className="dash-hint">
          Largo y ancho reales del vehículo (metros) - se usan para dibujar su silueta a escala real
          en el mapa, sin importar la precisión del GPS/RTK.
        </p>
        <div className="dash-overlay-toolbar">
          <button className="btn btn-sm" onClick={admin.openCreateVehicleType}>
            + Nuevo tipo
          </button>
        </div>
        {admin.vehicleTypes.length === 0 ? (
          <div className="org-empty">Sin tipos de vehículo todavía.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Categoría</th>
                <th>Largo (m)</th>
                <th>Ancho (m)</th>
                <th>Vel. máx (km/h)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {admin.vehicleTypes.map((vt) => (
                <tr key={vt.id}>
                  <td>{vt.name}</td>
                  <td>{vt.category === 'machinery' ? 'Maquinaria' : 'Transporte'}</td>
                  <td>{vt.length_meters.toFixed(2)}</td>
                  <td>{vt.width_meters.toFixed(2)}</td>
                  <td>{vt.max_speed_kmh != null ? vt.max_speed_kmh.toFixed(0) : '—'}</td>
                  <td className="org-row-actions">
                    <button className="btn btn-sm" onClick={() => admin.openEditVehicleType(vt)}>
                      Editar
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => admin.deleteVehicleType(vt)}>
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
        open={admin.vehicleTypeFormModal !== null}
        title={admin.vehicleTypeFormModal?.vehicleType ? 'Editar tipo de vehículo' : 'Nuevo tipo de vehículo'}
        onClose={() => admin.setVehicleTypeFormModal(null)}
      >
        <div className="gg-modal-field">
          <label>Nombre</label>
          <input
            placeholder="ej. Camión de volteo 14m³"
            value={admin.vehicleTypeForm.name}
            onChange={(e) => admin.setVehicleTypeForm({ ...admin.vehicleTypeForm, name: e.target.value })}
          />
        </div>
        <div className="gg-modal-field">
          <label>Largo (m)</label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            placeholder="ej. 8.50"
            value={admin.vehicleTypeForm.lengthMeters}
            onChange={(e) =>
              admin.setVehicleTypeForm({ ...admin.vehicleTypeForm, lengthMeters: e.target.value })
            }
          />
        </div>
        <div className="gg-modal-field">
          <label>Ancho (m)</label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            placeholder="ej. 2.60"
            value={admin.vehicleTypeForm.widthMeters}
            onChange={(e) =>
              admin.setVehicleTypeForm({ ...admin.vehicleTypeForm, widthMeters: e.target.value })
            }
          />
        </div>
        <div className="gg-modal-field">
          <label>Velocidad máxima (km/h)</label>
          <input
            type="number"
            step="1"
            min="1"
            placeholder="ej. 60 (opcional, deja vacío si no aplica)"
            value={admin.vehicleTypeForm.maxSpeedKmh}
            onChange={(e) =>
              admin.setVehicleTypeForm({ ...admin.vehicleTypeForm, maxSpeedKmh: e.target.value })
            }
          />
        </div>
        <div className="gg-modal-field">
          <label>Categoría</label>
          <select
            value={admin.vehicleTypeForm.category}
            onChange={(e) =>
              admin.setVehicleTypeForm({
                ...admin.vehicleTypeForm,
                category: e.target.value as 'transport' | 'machinery',
              })
            }
          >
            <option value="transport">Transporte (camión, camioneta, auto)</option>
            <option value="machinery">Maquinaria (excavadora, cargador, retro)</option>
          </select>
          <small>
            No es solo una etiqueta: decide cómo se comporta la tableta. <b>Transporte</b> congela la
            posición cuando el vehículo está detenido (menos de 4 km/h) y avisa antes de pasarse del
            límite si viene acelerando fuerte. <b>Maquinaria</b> nunca congela la posición, porque
            trabaja a velocidad de gateo y congelarla escondería trabajo real.
          </small>
        </div>
        <div className="gg-modal-actions">
          <button className="btn btn-sm" onClick={() => admin.setVehicleTypeFormModal(null)}>
            Cancelar
          </button>
          <button className="btn btn-sm" onClick={admin.saveVehicleType}>
            Guardar
          </button>
        </div>
      </Modal>
    </>
  );
}
