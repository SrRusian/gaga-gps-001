import { createApiClient, getStoredToken } from '@gaga-gps/client';
import { useEffect, useState } from 'react';

// Supervisor sí tiene sesión propia (a diferencia de useOperatorAuth,
// que usa este mismo cliente para el turno del operador) — se adjunta
// igual por si en el futuro esta ruta deja de ser pública.
const api = createApiClient({ getToken: getStoredToken });

const REFRESH_INTERVAL_MS = 20000;

export interface ActiveOperatorSession {
  id: number;
  user_id: number;
  device_id: string;
  started_at: string;
  ended_at: string | null;
  last_seen_at: string;
  user_name: string;
  user_email: string;
}

/**
 * Turno activo (operador + hora de inicio) de un dispositivo, si lo
 * hay — consulta el mismo endpoint que ya usa la UI de Operador para
 * saber si un vehículo ya tiene turno abierto
 * (GET /api/operator-sessions/active, pública). Se refresca cada
 * REFRESH_INTERVAL_MS mientras el panel de detalle esté abierto,
 * porque un cambio de turno no llega por Socket.io.
 */
export function useActiveOperatorSession(deviceId: string | null) {
  const [session, setSession] = useState<ActiveOperatorSession | null>(null);

  useEffect(() => {
    if (!deviceId) {
      setSession(null);
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const active = await api.get<ActiveOperatorSession | null>(
          `/api/operator-sessions/active?deviceId=${encodeURIComponent(deviceId!)}`,
        );
        if (!cancelled) setSession(active);
      } catch (err) {
        console.error('No se pudo obtener el turno activo:', (err as Error).message);
      }
    }

    load();
    const interval = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [deviceId]);

  return session;
}
