import { createApiClient, getStoredToken } from '@gaga-gps/client';
import type { InfractionRow } from '@gaga-gps/shared-types';
import { useState } from 'react';

const api = createApiClient({ getToken: getStoredToken });

// historial de solo lectura - las filas las genera unicamente el sistema (SpeedAlertService/
// GeofenceAlertService al cruzar un limite real, nunca por los avisos silenciosos de proximidad)
export function useInfractionHistory() {
  const [rows, setRows] = useState<InfractionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function search() {
    setLoading(true);
    setError('');
    try {
      setRows(await api.get<InfractionRow[]>('/api/infractions'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error obteniendo infracciones');
    } finally {
      setLoading(false);
    }
  }

  async function markReviewed(id: number, notes?: string) {
    await api.post(`/api/infractions/${id}/review`, notes ? { notes } : {});
    setRows((prev) =>
      prev.map((r) =>
        r.id === id ? { ...r, reviewed_at: new Date().toISOString(), review_notes: notes ?? null } : r,
      ),
    );
  }

  return { rows, loading, error, search, markReviewed };
}
