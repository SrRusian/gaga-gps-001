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

  async function search(filters?: { from?: string; to?: string }) {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (filters?.from) params.set('from', new Date(filters.from).toISOString());
      if (filters?.to) params.set('to', new Date(filters.to).toISOString());
      setRows(await api.get<InfractionRow[]>(`/api/infractions?${params.toString()}`));
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
