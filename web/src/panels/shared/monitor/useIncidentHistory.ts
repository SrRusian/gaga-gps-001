import { createApiClient, getStoredToken } from '@gaga-gps/client';
import { useState } from 'react';

const api = createApiClient({ getToken: getStoredToken });

export interface IncidentHistoryRow {
  id: number;
  device_id: string;
  device_name: string | null;
  reported_by_name: string | null;
  resolved_by_name: string | null;
  category: 'obstacle' | 'accident' | 'traffic' | 'other';
  message: string | null;
  status: 'open' | 'resolved';
  reported_at: string;
  resolved_at: string | null;
}

// abiertos + resueltos - reportes de "peligro en el camino" que el propio operador manda desde su
// panel. El backend acota solo a project_supervisor (siempre su dia actual, ignora from/to) -
// Encargado puede mandar from/to libremente, ver infractions.routes.ts para el mismo criterio.
export function useIncidentHistory() {
  const [rows, setRows] = useState<IncidentHistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function search(filters?: {
    from?: string;
    to?: string;
    status?: 'open' | 'resolved';
    deviceId?: string;
    reportedByName?: string;
  }) {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (filters?.from) params.set('from', new Date(filters.from).toISOString());
      if (filters?.to) params.set('to', new Date(filters.to).toISOString());
      if (filters?.status) params.set('status', filters.status);
      if (filters?.deviceId?.trim()) params.set('deviceId', filters.deviceId.trim());
      if (filters?.reportedByName?.trim()) params.set('reportedByName', filters.reportedByName.trim());
      setRows(await api.get<IncidentHistoryRow[]>(`/api/incidents/history?${params.toString()}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error obteniendo incidentes');
    } finally {
      setLoading(false);
    }
  }

  return { rows, loading, error, search };
}
