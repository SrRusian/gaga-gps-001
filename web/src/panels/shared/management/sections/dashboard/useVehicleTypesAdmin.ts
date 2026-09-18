import { useState } from 'react';
import { adminApi } from '../../api';
import type { VehicleTypeRow } from '../../types';

export interface VehicleTypeFormState {
  name: string;
  lengthMeters: string;
  widthMeters: string;
  // opcional - vacio = sin limite propio para este tipo (a diferencia de largo/ancho, obligatorios)
  maxSpeedKmh: string;
}

const EMPTY_FORM: VehicleTypeFormState = { name: '', lengthMeters: '', widthMeters: '', maxSpeedKmh: '' };

// catalogo global - solo admin lo administra (crea/edita/elimina), pero cualquier rol con acceso
// a Dispositivos necesita la lista para el <select> de asignacion (ver DevicesModal). El modal de
// administracion en si (VehicleTypesModal) solo se monta/muestra el boton para isAdmin.
export function useVehicleTypesAdmin() {
  const [vehicleTypes, setVehicleTypes] = useState<VehicleTypeRow[]>([]);
  const [vehicleTypesModalOpen, setVehicleTypesModalOpen] = useState(false);
  const [vehicleTypeForm, setVehicleTypeForm] = useState<VehicleTypeFormState>(EMPTY_FORM);
  // null = ningun formulario abierto, {} = creando uno nuevo, {vehicleType} = editando ese
  const [vehicleTypeFormModal, setVehicleTypeFormModal] = useState<{ vehicleType?: VehicleTypeRow } | null>(
    null,
  );

  async function loadVehicleTypes() {
    try {
      setVehicleTypes(await adminApi.get<VehicleTypeRow[]>('/api/vehicle-types'));
    } catch {
      setVehicleTypes([]);
    }
  }

  function openCreateVehicleType() {
    setVehicleTypeForm(EMPTY_FORM);
    setVehicleTypeFormModal({});
  }

  function openEditVehicleType(vt: VehicleTypeRow) {
    setVehicleTypeForm({
      name: vt.name,
      lengthMeters: String(vt.length_meters),
      widthMeters: String(vt.width_meters),
      maxSpeedKmh: vt.max_speed_kmh != null ? String(vt.max_speed_kmh) : '',
    });
    setVehicleTypeFormModal({ vehicleType: vt });
  }

  async function saveVehicleType() {
    const lengthMeters = parseFloat(vehicleTypeForm.lengthMeters);
    const widthMeters = parseFloat(vehicleTypeForm.widthMeters);
    const maxSpeedKmhTrimmed = vehicleTypeForm.maxSpeedKmh.trim();
    const maxSpeedKmh = maxSpeedKmhTrimmed ? parseFloat(maxSpeedKmhTrimmed) : null;
    if (!vehicleTypeForm.name.trim()) {
      alert('El nombre es requerido');
      return;
    }
    if (!(lengthMeters > 0) || !(widthMeters > 0)) {
      alert('Largo y ancho deben ser mayores a 0');
      return;
    }
    if (maxSpeedKmh !== null && !(maxSpeedKmh > 0)) {
      alert('La velocidad máxima debe ser mayor a 0 (o dejarse vacía si no aplica)');
      return;
    }
    try {
      if (vehicleTypeFormModal?.vehicleType) {
        await adminApi.patch(`/api/vehicle-types/${vehicleTypeFormModal.vehicleType.id}`, {
          name: vehicleTypeForm.name,
          lengthMeters,
          widthMeters,
          maxSpeedKmh,
        });
      } else {
        await adminApi.post('/api/vehicle-types', {
          name: vehicleTypeForm.name,
          lengthMeters,
          widthMeters,
          maxSpeedKmh,
        });
      }
      setVehicleTypeFormModal(null);
      loadVehicleTypes();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error guardando tipo de vehículo');
    }
  }

  async function deleteVehicleType(vt: VehicleTypeRow) {
    if (
      !confirm(
        `¿Eliminar el tipo "${vt.name}"? Los dispositivos que lo tengan asignado se quedarán sin tipo (sin silueta en el mapa) hasta que se les asigne uno nuevo.`,
      )
    ) {
      return;
    }
    try {
      await adminApi.delete(`/api/vehicle-types/${vt.id}`);
      loadVehicleTypes();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error eliminando tipo de vehículo');
    }
  }

  return {
    vehicleTypes,
    vehicleTypesModalOpen,
    setVehicleTypesModalOpen,
    vehicleTypeForm,
    setVehicleTypeForm,
    vehicleTypeFormModal,
    setVehicleTypeFormModal,
    loadVehicleTypes,
    openCreateVehicleType,
    openEditVehicleType,
    saveVehicleType,
    deleteVehicleType,
  };
}

export type VehicleTypesAdmin = ReturnType<typeof useVehicleTypesAdmin>;
