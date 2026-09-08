import { Modal } from '@gaga-gps/ui';
import type { ShiftsAdmin } from '../useShiftsAdmin';

export interface ShiftsModalProps {
  open: boolean;
  onClose: () => void;
  scopeLabel: string;
  admin: ShiftsAdmin;
}

export function ShiftsModal({ open, onClose, scopeLabel, admin }: ShiftsModalProps) {
  return (
    <>
      <Modal size="large" open={open} title={`Turnos - ${scopeLabel}`} onClose={onClose}>
        <div className="dash-overlay-toolbar">
          <button className="btn btn-sm" onClick={admin.openCreateShift}>
            + Nuevo turno
          </button>
        </div>
        {admin.shifts.length === 0 ? (
          <div className="org-empty">Sin turnos todavía.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Horario</th>
                <th>Supervisor</th>
                <th>
                  <span className="dash-th-with-info">
                    Activo
                    <span
                      className="dash-info-icon"
                      title="Un turno inactivo se pausa temporalmente sin perder su configuración. Mientras esté así, el sistema no lo usa para asignar el turno de un operador que inicia sesión en ese horario. No indica si alguien está trabajando en este momento."
                    >
                      i
                    </span>
                  </span>
                </th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {admin.shifts.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>
                    {s.start_time.slice(0, 5)}-{s.end_time.slice(0, 5)}
                  </td>
                  <td>
                    <select
                      value={s.supervisor_user_id ?? ''}
                      onChange={(e) => admin.assignSupervisor(s.id, e.target.value)}
                    >
                      <option value="">Sin asignar</option>
                      {admin.supervisorCandidates.map((sup) => (
                        <option key={sup.id} value={sup.id}>
                          {sup.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td
                    className={s.active ? 'status-online' : 'status-offline'}
                    title="Indica si este horario se usa para asignar turnos automáticamente. No indica si alguien está trabajando en este momento."
                  >
                    {s.active ? 'Sí' : 'No'}
                  </td>
                  <td className="org-row-actions">
                    <button className="btn btn-sm" onClick={() => admin.openEditShift(s)}>
                      Editar
                    </button>
                    <button className="btn btn-sm" onClick={() => admin.toggleShiftActive(s)}>
                      {s.active ? 'Desactivar' : 'Activar'}
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => admin.deleteShift(s)}>
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
        open={admin.shiftModal !== null}
        title={admin.shiftModal?.shift ? 'Editar turno' : 'Nuevo turno'}
        onClose={() => admin.setShiftModal(null)}
      >
        <div className="gg-modal-field">
          <label>Nombre</label>
          <input
            placeholder="ej. Matutino"
            value={admin.shiftForm.name}
            onChange={(e) => admin.setShiftForm({ ...admin.shiftForm, name: e.target.value })}
          />
        </div>
        <div className="gg-modal-field">
          <label>Hora de inicio</label>
          <input
            type="time"
            value={admin.shiftForm.startTime}
            onChange={(e) => admin.setShiftForm({ ...admin.shiftForm, startTime: e.target.value })}
          />
        </div>
        <div className="gg-modal-field">
          <label>Hora de fin</label>
          <input
            type="time"
            value={admin.shiftForm.endTime}
            onChange={(e) => admin.setShiftForm({ ...admin.shiftForm, endTime: e.target.value })}
          />
        </div>
        <div className="gg-modal-actions">
          <button className="btn btn-sm" onClick={() => admin.setShiftModal(null)}>
            Cancelar
          </button>
          <button className="btn btn-sm" onClick={admin.saveShift}>
            Guardar
          </button>
        </div>
      </Modal>
    </>
  );
}
