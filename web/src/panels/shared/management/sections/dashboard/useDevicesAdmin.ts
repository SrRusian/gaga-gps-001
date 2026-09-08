import { useMemo, useState } from 'react';
import { adminApi } from '../../api';
import type { DeviceRow } from '../../types';
import type { Scope } from './scope';

export interface DeviceFormState {
  uniqueId: string;
  name: string;
  type: string;
  projectId: string;
}

export interface UseDevicesAdminOptions {
  scope: Scope;
  isAdmin: boolean;
  onDeviceDeleted: (deviceUniqueId: string, hadLinkedEquipment: boolean) => void;
}

export function useDevicesAdmin({ scope, isAdmin, onDeviceDeleted }: UseDevicesAdminOptions) {
  const [allDevices, setAllDevices] = useState<DeviceRow[]>([]);
  const [deviceSearch, setDeviceSearch] = useState('');
  const [deviceModal, setDeviceModal] = useState<{ device?: DeviceRow } | null>(null);
  const [deviceForm, setDeviceForm] = useState<DeviceFormState>({
    uniqueId: '',
    name: '',
    type: 'vehicle',
    projectId: '',
  });

  async function loadDevices() {
    setAllDevices(await adminApi.get<DeviceRow[]>('/api/devices'));
  }

  const scopedDevices = useMemo(() => {
    let list = scope === 'global' ? allDevices : allDevices.filter((d) => d.project_id === scope);
    if (deviceSearch.trim()) {
      const q = deviceSearch.trim().toLowerCase();
      list = list.filter(
        (d) => d.name.toLowerCase().includes(q) || d.unique_id.toLowerCase().includes(q),
      );
    }
    return [...list].sort((a, b) => Number(a.project_id !== null) - Number(b.project_id !== null));
  }, [allDevices, scope, deviceSearch]);

  function openCreateDevice() {
    setDeviceForm({ uniqueId: '', name: '', type: 'vehicle', projectId: '' });
    setDeviceModal({});
  }

  function openEditDevice(d: DeviceRow) {
    setDeviceForm({
      uniqueId: d.unique_id,
      name: d.name,
      type: d.type,
      projectId: d.project_id != null ? String(d.project_id) : '',
    });
    setDeviceModal({ device: d });
  }

  async function saveDevice() {
    if (!deviceForm.name.trim()) {
      alert('El nombre es requerido');
      return;
    }
    try {
      if (deviceModal?.device) {
        await adminApi.patch(`/api/devices/${deviceModal.device.id}`, {
          name: deviceForm.name,
          type: deviceForm.type,
          ...(isAdmin
            ? { projectId: deviceForm.projectId ? Number(deviceForm.projectId) : null }
            : {}),
        });
      } else {
        if (!deviceForm.uniqueId.trim()) {
          alert('El ID único (Traccar Client) es requerido');
          return;
        }
        const projectId =
          typeof scope === 'number'
            ? scope
            : deviceForm.projectId
              ? Number(deviceForm.projectId)
              : null;
        await adminApi.post('/api/devices', {
          uniqueId: deviceForm.uniqueId,
          name: deviceForm.name,
          type: deviceForm.type || 'vehicle',
          projectId,
        });
      }
      setDeviceModal(null);
      loadDevices();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error guardando dispositivo');
    }
  }

  async function deleteDevice(d: DeviceRow, findLinkedEquipmentName: (uniqueId: string) => string | undefined) {
    const linkedEquipmentName = findLinkedEquipmentName(d.unique_id);
    const linkedNote = linkedEquipmentName
      ? ` El equipo estático "${linkedEquipmentName}" que tiene vinculada esta tableta quedará sin dispositivo asignado (el equipo en sí no se elimina).`
      : '';
    const typed = prompt(
      `Esta acción no se puede deshacer. Se eliminará también todo su historial (posiciones, ` +
        `sensores, eventos de geocerca, incidentes reportados y alertas).${linkedNote} Para eliminar ` +
        `"${d.unique_id}", escriba exactamente su ID:`,
    );
    if (typed === null) return;
    if (typed !== d.unique_id) {
      alert('El ID no coincide - no se eliminó el dispositivo');
      return;
    }
    try {
      await adminApi.delete(`/api/devices/${d.id}?force=true`);
      loadDevices();
      onDeviceDeleted(d.unique_id, linkedEquipmentName !== undefined);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error eliminando dispositivo');
    }
  }

  return {
    allDevices,
    scopedDevices,
    deviceSearch,
    setDeviceSearch,
    deviceModal,
    setDeviceModal,
    deviceForm,
    setDeviceForm,
    loadDevices,
    openCreateDevice,
    openEditDevice,
    saveDevice,
    deleteDevice,
  };
}

export type DevicesAdmin = ReturnType<typeof useDevicesAdmin>;
