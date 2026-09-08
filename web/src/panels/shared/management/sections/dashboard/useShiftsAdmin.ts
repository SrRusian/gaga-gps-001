import { useEffect, useState } from 'react';
import { adminApi } from '../../api';
import type { ShiftRow, UserRow } from '../../types';
import type { Scope } from './scope';

export interface ShiftFormState {
  name: string;
  startTime: string;
  endTime: string;
}

export interface UseShiftsAdminOptions {
  scope: Scope;
  isAdmin: boolean;
  allUsers: UserRow[];
}

export function useShiftsAdmin({ scope, isAdmin, allUsers }: UseShiftsAdminOptions) {
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [shiftModal, setShiftModal] = useState<{ shift?: ShiftRow } | null>(null);
  const [shiftForm, setShiftForm] = useState<ShiftFormState>({
    name: '',
    startTime: '07:00',
    endTime: '15:00',
  });

  async function loadShifts() {
    if (typeof scope !== 'number') {
      setShifts([]);
      return;
    }
    const query = isAdmin ? `?projectId=${scope}` : '';
    setShifts(await adminApi.get<ShiftRow[]>(`/api/shifts${query}`));
  }

  useEffect(() => {
    loadShifts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const supervisorCandidates = allUsers.filter(
    (u) => u.role === 'project_supervisor' && u.project_id === scope,
  );

  function openCreateShift() {
    setShiftForm({ name: '', startTime: '07:00', endTime: '15:00' });
    setShiftModal({});
  }

  function openEditShift(s: ShiftRow) {
    setShiftForm({ name: s.name, startTime: s.start_time.slice(0, 5), endTime: s.end_time.slice(0, 5) });
    setShiftModal({ shift: s });
  }

  async function saveShift() {
    if (!shiftForm.name.trim()) {
      alert('El nombre del turno es requerido');
      return;
    }
    try {
      if (shiftModal?.shift) {
        await adminApi.patch(`/api/shifts/${shiftModal.shift.id}`, {
          name: shiftForm.name,
          startTime: `${shiftForm.startTime}:00`,
          endTime: `${shiftForm.endTime}:00`,
        });
      } else {
        await adminApi.post('/api/shifts', {
          name: shiftForm.name,
          startTime: `${shiftForm.startTime}:00`,
          endTime: `${shiftForm.endTime}:00`,
          projectId: typeof scope === 'number' ? scope : undefined,
        });
      }
      setShiftModal(null);
      loadShifts();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error guardando turno');
    }
  }

  async function assignSupervisor(shiftId: number, supervisorUserId: string) {
    await adminApi.patch(`/api/shifts/${shiftId}`, {
      supervisorUserId: supervisorUserId ? Number(supervisorUserId) : null,
    });
    loadShifts();
  }

  async function toggleShiftActive(s: ShiftRow) {
    await adminApi.patch(`/api/shifts/${s.id}`, { active: !s.active });
    loadShifts();
  }

  async function deleteShift(s: ShiftRow) {
    const typed = prompt(
      `Esta acción no se puede deshacer. Las sesiones de operador que ya trabajaron bajo este ` +
        `turno conservan su historial de horas - solo quedan sin turno asociado. Para eliminar ` +
        `"${s.name}", escriba exactamente su nombre:`,
    );
    if (typed === null) return;
    if (typed !== s.name) {
      alert('El nombre no coincide - no se eliminó el turno');
      return;
    }
    try {
      await adminApi.delete(`/api/shifts/${s.id}`);
      loadShifts();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error eliminando turno');
    }
  }

  return {
    shifts,
    supervisorCandidates,
    shiftModal,
    setShiftModal,
    shiftForm,
    setShiftForm,
    loadShifts,
    openCreateShift,
    openEditShift,
    saveShift,
    assignSupervisor,
    toggleShiftActive,
    deleteShift,
  };
}

export type ShiftsAdmin = ReturnType<typeof useShiftsAdmin>;
