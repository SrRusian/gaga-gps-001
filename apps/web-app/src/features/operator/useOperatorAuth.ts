import { ApiError, createApiClient, getStoredToken, getStoredUser } from '@gaga-gps/client';
import { useCallback, useEffect, useRef, useState } from 'react';

// getToken lee siempre el valor más reciente de localStorage — la
// sesión la escribe el login único (features/auth), esta app solo
// la lee. ProtectedRoute ya garantizó rol "operator" antes de montar
// este componente.
const api = createApiClient({ getToken: getStoredToken });

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export interface OperatorSession {
  id: number;
  user_name: string;
}

interface StartSessionResponse {
  id: number;
}

/**
 * Identifica QUIÉN opera este vehículo — independiente de deviceId
 * (fijo por configuración de kiosco). Un mismo operador puede
 * iniciar turno en máquinas distintas en turnos distintos; el
 * backend lleva el registro por separado (operator_sessions).
 *
 * Solo verifica si este dispositivo tiene un turno activo y, si no,
 * ofrece iniciarlo (sin pedir credenciales — la identidad ya está
 * resuelta por el login único).
 */
export function useOperatorAuth(deviceId: string | null) {
  const [session, setSession] = useState<OperatorSession | null>(null);
  const [needsShiftStart, setNeedsShiftStart] = useState(false);
  const [shiftStartError, setShiftStartError] = useState('');
  const [checking, setChecking] = useState(true);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const startHeartbeat = useCallback(
    (sessionId: number) => {
      stopHeartbeat();
      heartbeatRef.current = setInterval(async () => {
        try {
          await api.post(`/api/operator-sessions/${sessionId}/heartbeat`);
        } catch (err) {
          console.error('Error en heartbeat de turno:', (err as Error).message);
        }
      }, HEARTBEAT_INTERVAL_MS);
    },
    [stopHeartbeat],
  );

  // Verifica si este dispositivo ya tiene un turno activo vigente
  // según el backend (fuente de verdad) — si alguien más cerró el
  // turno (o inició otro) desde el panel admin u otro dispositivo,
  // se pide iniciar turno de nuevo.
  useEffect(() => {
    if (!deviceId) {
      setChecking(false);
      return;
    }

    const user = getStoredUser();

    (async () => {
      try {
        const active = await api.get<{ id: number } | null>(
          `/api/operator-sessions/active?deviceId=${encodeURIComponent(deviceId)}`,
        );
        if (active) {
          setSession({ id: active.id, user_name: user?.name ?? '' });
          startHeartbeat(active.id);
          setChecking(false);
          return;
        }
      } catch (err) {
        console.error('No se pudo verificar el turno activo:', (err as Error).message);
      }

      setNeedsShiftStart(true);
      setChecking(false);
    })();
  }, [deviceId, startHeartbeat]);

  const startShift = useCallback(async () => {
    if (!deviceId) return;
    setShiftStartError('');
    try {
      const user = getStoredUser();
      const sessionData = await api.post<StartSessionResponse>('/api/operator-sessions/start', {
        deviceId,
      });
      setSession({ id: sessionData.id, user_name: user?.name ?? '' });
      setNeedsShiftStart(false);
      startHeartbeat(sessionData.id);
    } catch (err) {
      setShiftStartError(err instanceof ApiError ? err.message : 'No se pudo iniciar el turno');
    }
  }, [deviceId, startHeartbeat]);

  const endShift = useCallback(async () => {
    if (!session) return;
    if (!confirm('¿Finalizar tu turno?')) return;

    try {
      await api.post(`/api/operator-sessions/${session.id}/end`);
    } catch (err) {
      console.error('Error cerrando turno (se limpia localmente igual):', (err as Error).message);
    }

    setSession(null);
    setNeedsShiftStart(true);
    stopHeartbeat();
  }, [session, stopHeartbeat]);

  useEffect(() => stopHeartbeat, [stopHeartbeat]);

  return { session, needsShiftStart, shiftStartError, checking, startShift, endShift };
}
