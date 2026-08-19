import { createApiClient, getStoredToken } from '@gaga-gps/client';
import type { AlertEventSeverity, AlertEventType, AlertHistoryRow } from '@gaga-gps/shared-types';
import { useState } from 'react';

const api = createApiClient({ getToken: getStoredToken });

export interface AlertHistoryFilters {
  type: AlertEventType | '';
  severity: AlertEventSeverity | '';
  deviceId: string;
  from: string;
  to: string;
}

export const EMPTY_FILTERS: AlertHistoryFilters = {
  type: '',
  severity: '',
  deviceId: '',
  from: '',
  to: '',
};

function toQuery(filters: AlertHistoryFilters): string {
  const params = new URLSearchParams();
  if (filters.type) params.set('type', filters.type);
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.deviceId.trim()) params.set('deviceId', filters.deviceId.trim());
  if (filters.from) params.set('from', new Date(filters.from).toISOString());
  if (filters.to) params.set('to', new Date(filters.to).toISOString());
  return params.toString();
}

export function useAlertHistory() {
  const [rows, setRows] = useState<AlertHistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function search(filters: AlertHistoryFilters) {
    setLoading(true);
    setError('');
    try {
      setRows(await api.get<AlertHistoryRow[]>(`/api/alerts/history?${toQuery(filters)}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error obteniendo historial');
    } finally {
      setLoading(false);
    }
  }

  async function exportCsv(filters: AlertHistoryFilters) {
    const token = getStoredToken();
    const res = await fetch(`/api/alerts/history/csv?${toQuery(filters)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'historial_alertas.csv';
    a.click();
  }

  return { rows, loading, error, search, exportCsv };
}
