import { Modal } from '@gaga-gps/ui';
import type { ProjectRow } from '../../../types';
import type { EquipmentAdmin } from '../useEquipmentAdmin';
import type { Scope } from '../scope';

export interface EquipmentModalProps {
  open: boolean;
  onClose: () => void;
  scope: Scope;
  scopeLabel: string;
  projects: ProjectRow[];
  admin: EquipmentAdmin;
  onStartCreate: () => void;
  onEdit: (id: number) => void;
}

export function EquipmentModal({
  open,
  onClose,
  scope,
  scopeLabel,
  projects,
  admin,
  onStartCreate,
  onEdit,
}: EquipmentModalProps) {
  return (
    <Modal size="large" open={open} title={`Equipo estático - ${scopeLabel}`} onClose={onClose}>
      <div className="dash-overlay-toolbar">
        <button className="btn btn-sm" onClick={onStartCreate}>
          + Nuevo equipo
        </button>
      </div>
      {admin.scopedEquipment.length === 0 ? (
        <div className="org-empty">Sin equipo estático todavía.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Tipo</th>
              {scope === 'global' && <th>Proyecto</th>}
              <th>Radio giro</th>
              <th>Radio seguridad</th>
              <th>Dispositivo</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {admin.scopedEquipment.map((eq) => (
              <tr key={eq.id}>
                <td>{eq.name}</td>
                <td>{eq.type}</td>
                {scope === 'global' && <td>{projects.find((p) => p.id === eq.project_id)?.name ?? '-'}</td>}
                <td>{eq.swing_radius}</td>
                <td>{eq.safety_radius}</td>
                <td>
                  {eq.linked_device_id
                    ? (admin.allDevices.find((d) => d.unique_id === eq.linked_device_id)?.name ??
                      eq.linked_device_id)
                    : '-'}
                </td>
                <td>
                  {eq.linked_device_id
                    ? eq.status === 'inactive'
                      ? 'Inactivo (sin turno)'
                      : 'En operación'
                    : eq.status}
                </td>
                <td className="org-row-actions">
                  <button className="btn btn-sm" onClick={() => onEdit(eq.id)}>
                    Editar
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => admin.deleteEquipmentRow(eq)}>
                    Eliminar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
