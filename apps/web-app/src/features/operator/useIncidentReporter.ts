import { ApiError, createApiClient, getStoredToken } from '@gaga-gps/client';
import type { IncidentCategory } from '@gaga-gps/shared-types';
import { useState } from 'react';

const api = createApiClient({ getToken: getStoredToken });

export function useIncidentReporter(deviceId: string | null) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function report(
    category: IncidentCategory,
    message: string,
    latitude: number,
    longitude: number,
  ): Promise<boolean> {
    if (!deviceId) return false;
    setSubmitting(true);
    setError('');
    try {
      await api.post('/api/incidents', {
        deviceId,
        category,
        message: message || undefined,
        latitude,
        longitude,
      });
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error reportando el peligro');
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  return { report, submitting, error };
}
