import { createApiClient, getStoredToken } from '@gaga-gps/client';
import { useEffect, useState } from 'react';

const api = createApiClient({ getToken: getStoredToken });

const REFRESH_INTERVAL_MS = 20000;

interface ShiftWithRoster {
  id: number;
  name: string;
  roster: { device_id: string }[];
}

/**
 * Roster (deviceIds) del turno asignado a un Supervisor de Proyecto -
 * a diferencia del Encargado de Proyecto (ve todo el proyecto sin
 * filtrar), este rol solo debe ver su propio turno. `null` cuando el
 * rol no aplica (Supervisor "clásico"/Encargado) - en ese caso
 * SupervisorApp no filtra nada, mismo comportamiento de siempre.
 */
export function useMyShift(enabled: boolean) {
  const [deviceIds, setDeviceIds] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function load() {
      try {
        const shifts = await api.get<ShiftWithRoster[]>('/api/shifts/mine');
        if (cancelled) return;
        const ids = new Set<string>();
        shifts.forEach((s) => s.roster.forEach((r) => ids.add(r.device_id)));
        setDeviceIds(ids);
      } catch (err) {
        console.error('No se pudo obtener el turno asignado:', (err as Error).message);
      }
    }

    load();
    const interval = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled]);

  return deviceIds;
}
