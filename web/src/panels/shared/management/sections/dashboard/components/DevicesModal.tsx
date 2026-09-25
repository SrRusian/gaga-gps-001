import { Modal } from '@gaga-gps/ui';
import type { ProjectRow } from '../../../types';
import type { DevicesAdmin } from '../useDevicesAdmin';
import type { VehicleTypesAdmin } from '../useVehicleTypesAdmin';
import type { Scope } from '../scope';
import { VehicleTypesModal } from './VehicleTypesModal';

export interface DevicesModalProps {
  open: boolean;
  onClose: () => void;
  scope: Scope;
  scopeLabel: string;
  isAdmin: boolean;
  projects: ProjectRow[];
  findLinkedEquipmentName: (deviceUniqueId: string) => string | undefined;
  admin: DevicesAdmin;
  vehicleTypesAdmin: VehicleTypesAdmin;
}

export function DevicesModal({
  open,
  onClose,
  scope,
  scopeLabel,
  isAdmin,
  projects,
  findLinkedEquipmentName,
  admin,
  vehicleTypesAdmin,
}: DevicesModalProps) {
  return (
    <>
      <Modal size="large" open={open} title={`Dispositivos - ${scopeLabel}`} onClose={onClose}>
        <div className="dash-overlay-toolbar">
          <input
            placeholder="Buscar…"
            value={admin.deviceSearch}
            onChange={(e) => admin.setDeviceSearch(e.target.value)}
          />
          <button className="btn btn-sm" onClick={admin.openCreateDevice}>
            + Nuevo
          </button>
          {isAdmin && (
            <button className="btn btn-sm" onClick={() => vehicleTypesAdmin.setVehicleTypesModalOpen(true)}>
              Administrar tipos de vehículo
            </button>
          )}
        </div>
        {admin.scopedDevices.length === 0 ? (
          <div className="org-empty">Sin dispositivos todavía.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Nombre</th>
                <th>Tipo de vehículo</th>
                {scope === 'global' && <th>Proyecto</th>}
                <th>Estado</th>
                <th>Equipo estático</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {admin.scopedDevices.map((d) => (
                <tr key={d.id}>
                  <td>{d.unique_id}</td>
                  <td>{d.name}</td>
                  <td>{d.vehicle_type_name ?? '-'}</td>
                  {scope === 'global' && (
                    <td>{projects.find((p) => p.id === d.project_id)?.name ?? 'Sin asignar'}</td>
                  )}
                  <td className={`status-${d.status}`}>{d.status}</td>
                  <td>{findLinkedEquipmentName(d.unique_id) ?? '-'}</td>
                  <td className="org-row-actions">
                    <button className="btn btn-sm" onClick={() => admin.openEditDevice(d)}>
                      Editar
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => admin.deleteDevice(d, findLinkedEquipmentName)}
                    >
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
        open={admin.deviceModal !== null}
        title={admin.deviceModal?.device ? 'Editar dispositivo' : 'Nuevo dispositivo'}
        onClose={() => admin.setDeviceModal(null)}
      >
        {!admin.deviceModal?.device && (
          <div className="gg-modal-field">
            <label>ID único (Traccar Client)</label>
            <input
              value={admin.deviceForm.uniqueId}
              onChange={(e) => admin.setDeviceForm({ ...admin.deviceForm, uniqueId: e.target.value })}
            />
          </div>
        )}
        <div className="gg-modal-field">
          <label>Nombre</label>
          <input
            value={admin.deviceForm.name}
            onChange={(e) => admin.setDeviceForm({ ...admin.deviceForm, name: e.target.value })}
          />
        </div>
        <div className="gg-modal-field">
          <label>Tipo de vehículo (silueta a escala real en el mapa)</label>
          <select
            value={admin.deviceForm.vehicleTypeId}
            onChange={(e) => admin.setDeviceForm({ ...admin.deviceForm, vehicleTypeId: e.target.value })}
          >
            <option value="">Sin asignar</option>
            {vehicleTypesAdmin.vehicleTypes.map((vt) => (
              <option key={vt.id} value={vt.id}>
                {vt.name} ({vt.length_meters.toFixed(2)}m x {vt.width_meters.toFixed(2)}m)
              </option>
            ))}
          </select>
        </div>
        {admin.deviceModal?.device && (
          // sin .gg-modal-field envolviendo el <input> a proposito - ese selector estiliza inputs de
          // texto (fondo oscuro, padding, border-radius), se ve roto aplicado a un checkbox
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0' }}>
            <input
              type="checkbox"
              id="device-restricted-zone"
              checked={admin.deviceForm.restrictedToAllowedZone}
              onChange={(e) =>
                admin.setDeviceForm({ ...admin.deviceForm, restrictedToAllowedZone: e.target.checked })
              }
            />
            <label htmlFor="device-restricted-zone" style={{ fontSize: 12, color: '#7d93b8' }}>
              Restringido a zona permitida (debe quedarse dentro - salir genera infracción)
            </label>
          </div>
        )}
        {isAdmin && (admin.deviceModal?.device || scope === 'global') && (
          <div className="gg-modal-field">
            <label>Proyecto</label>
            <select
              value={admin.deviceForm.projectId}
              onChange={(e) => admin.setDeviceForm({ ...admin.deviceForm, projectId: e.target.value })}
            >
              <option value="">Sin asignar</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="gg-modal-actions">
          <button className="btn btn-sm" onClick={() => admin.setDeviceModal(null)}>
            Cancelar
          </button>
          <button className="btn btn-sm" onClick={admin.saveDevice}>
            Guardar
          </button>
        </div>
      </Modal>

      {isAdmin && (
        <VehicleTypesModal
          open={vehicleTypesAdmin.vehicleTypesModalOpen}
          onClose={() => vehicleTypesAdmin.setVehicleTypesModalOpen(false)}
          admin={vehicleTypesAdmin}
        />
      )}
    </>
  );
}
