import { useState } from 'react';
import { adminApi } from '../../api';
import type { VehicleTypeRow } from '../../types';

export interface VehicleTypeFormState {
  name: string;
  lengthMeters: string;
  widthMeters: string;
}

const EMPTY_FORM: VehicleTypeFormState = { name: '', lengthMeters: '', widthMeters: '' };

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
    });
    setVehicleTypeFormModal({ vehicleType: vt });
  }

  async function saveVehicleType() {
    const lengthMeters = parseFloat(vehicleTypeForm.lengthMeters);
    const widthMeters = parseFloat(vehicleTypeForm.widthMeters);
    if (!vehicleTypeForm.name.trim()) {
      alert('El nombre es requerido');
      return;
    }
    if (!(lengthMeters > 0) || !(widthMeters > 0)) {
      alert('Largo y ancho deben ser mayores a 0');
      return;
    }
    try {
      if (vehicleTypeFormModal?.vehicleType) {
        await adminApi.patch(`/api/vehicle-types/${vehicleTypeFormModal.vehicleType.id}`, {
          name: vehicleTypeForm.name,
          lengthMeters,
          widthMeters,
        });
      } else {
        await adminApi.post('/api/vehicle-types', { name: vehicleTypeForm.name, lengthMeters, widthMeters });
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
