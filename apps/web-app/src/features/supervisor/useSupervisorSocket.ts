import {
  clearSession,
  createApiClient,
  createSocket,
  getStoredToken,
  goToLogin,
} from '@gaga-gps/client';
import type { ActiveMap, Geofence, Position, PreventiveStopStatus } from '@gaga-gps/shared-types';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface FleetVehicle extends Position {
  lastSeen: number;
}

export interface AlertEntry {
  id: number;
  message: string;
  severity: 'danger' | 'warning' | 'info';
  time: string;
}

const MAX_ALERTS = 10;

const api = createApiClient({
  getToken: getStoredToken,
  onUnauthorized: () => {
    clearSession();
    goToLogin();
  },
});

export function useSupervisorSocket() {
  const [connected, setConnected] = useState(false);
  const [fleet, setFleet] = useState<Record<string, FleetVehicle>>({});
  const [geofences, setGeofences] = useState<Geofence[]>([]);
  const [activeMaps, setActiveMaps] = useState<ActiveMap[]>([]);
  const [alerts, setAlerts] = useState<AlertEntry[]>([]);
  const [alertCount, setAlertCount] = useState(0);
  const [stopStatus, setStopStatus] = useState<{ active: boolean; reason?: string }>({
    active: false,
  });
  const alertIdRef = useRef(0);

  const addAlert = useCallback((message: string, severity: AlertEntry['severity']) => {
    alertIdRef.current += 1;
    const entry: AlertEntry = {
      id: alertIdRef.current,
      message,
      severity,
      time: new Date().toLocaleTimeString('es-MX'),
    };
    setAlerts((prev) => [entry, ...prev].slice(0, MAX_ALERTS));
    setAlertCount((prev) => prev + 1);
  }, []);

  useEffect(() => {
    const socket = createSocket();

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('maps:active_update', ({ maps }) => setActiveMaps(maps));
    socket.on('geofences:update', (gs) => setGeofences(gs));

    socket.on('fleet:update', (data) => {
      setFleet((prev) => {
        const next = { ...prev };
        data.positions.forEach((pos) => {
          const lastSeen = pos.fixTime ? new Date(pos.fixTime).getTime() : Date.now();
          next[pos.deviceId] = { ...pos, lastSeen };
        });
        return next;
      });
    });

    socket.on('supervisor:alert', (data) => {
      if (data.action === 'entered') {
        addAlert(`🚨 Vehículo ${data.deviceId} — ${data.geofenceName ?? ''}`, 'danger');
      }
    });

    socket.on('supervisor:signal_lost', (data) => {
      if (data.level === 1) {
        addAlert(`⚠️ Vehículo ${data.deviceId} sin señal (${data.elapsedSeconds}s)`, 'warning');
      } else if (data.level === 2) {
        addAlert(`🚨 EMERGENCIA — Vehículo ${data.deviceId} desconectado`, 'danger');
      } else if (data.level === 0) {
        addAlert(`✅ Vehículo ${data.deviceId} reconectado`, 'info');
        setAlertCount((prev) => Math.max(0, prev - 1));
      }
    });

    socket.on('supervisor:collision', (data) => {
      const label = data.level === 2 ? '🚨 COLISIÓN INMINENTE' : '⚠️ Proximidad';
      addAlert(
        `${label} — V${data.deviceId1} y V${data.deviceId2} a ${data.distance}m`,
        data.level === 2 ? 'danger' : 'warning',
      );
    });

    socket.on('supervisor:preventive_stop', (data) => {
      if (data.active) {
        addAlert(`🛑 PARADA PREVENTIVA ACTIVADA — ${data.reason ?? ''}`, 'danger');
      } else {
        addAlert('✅ Parada preventiva desactivada', 'info');
      }
    });

    socket.on('fleet:preventive_stop', (data) => {
      setStopStatus({ active: true, reason: data.reason });
    });
    socket.on('fleet:preventive_stop_clear', () => {
      setStopStatus({ active: false });
    });

    return () => {
      socket.disconnect();
    };
  }, [addAlert]);

  const activateStop = useCallback(async () => {
    await api.post<{ success: boolean; status: PreventiveStopStatus }>('/api/fleet/stop', {
      reason: 'Activado manualmente por supervisor',
    });
    setStopStatus({ active: true, reason: 'Activado manualmente por supervisor' });
  }, []);

  const deactivateStop = useCallback(async () => {
    await api.post('/api/fleet/resume');
    setStopStatus({ active: false });
  }, []);

  return {
    connected,
    fleet,
    geofences,
    activeMaps,
    alerts,
    alertCount,
    stopStatus,
    activateStop,
    deactivateStop,
  };
}
