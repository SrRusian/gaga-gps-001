import {
  clearSession,
  createApiClient,
  createSocket,
  getStoredToken,
  goToLogin,
} from '@gaga-gps/client';
import type { ActiveMap, Geofence, Position, PreventiveStopStatus } from '@gaga-gps/shared-types';
import { useCallback, useEffect, useMemo, useState } from 'react';

export interface FleetVehicle extends Position {
  lastSeen: number;
}

export interface AlertEntry {
  key: string;
  message: string;
  severity: 'danger' | 'warning' | 'info';
  since: string;
}

const SEVERITY_RANK: Record<AlertEntry['severity'], number> = { danger: 0, warning: 1, info: 2 };

const api = createApiClient({
  getToken: getStoredToken,
  onUnauthorized: () => {
    clearSession();
    goToLogin();
  },
});

function pairKey(prefix: string, a: string | number, b: string | number): string {
  return `${prefix}:${[a, b].sort().join('-')}`;
}

export function useSupervisorSocket() {
  const [connected, setConnected] = useState(false);
  const [fleet, setFleet] = useState<Record<string, FleetVehicle>>({});
  const [geofences, setGeofences] = useState<Geofence[]>([]);
  const [activeMaps, setActiveMaps] = useState<ActiveMap[]>([]);
  const [activeAlerts, setActiveAlerts] = useState<Record<string, AlertEntry>>({});
  const [stopStatus, setStopStatus] = useState<{ active: boolean; reason?: string }>({
    active: false,
  });

  const upsertAlert = useCallback(
    (key: string, message: string, severity: AlertEntry['severity']) => {
      setActiveAlerts((prev) => ({
        ...prev,
        [key]: { key, message, severity, since: prev[key]?.since ?? new Date().toLocaleTimeString('es-MX') },
      }));
    },
    [],
  );

  const resolveAlert = useCallback((key: string) => {
    setActiveAlerts((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
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
      const key = `geofence:${data.deviceId}`;
      if (data.action !== 'entered') {
        resolveAlert(key);
        return;
      }
      const severity =
        data.type === 'geofence_red' ? 'danger' : data.type === 'geofence_parking' ? 'info' : 'warning';
      upsertAlert(key, `Vehículo ${data.deviceId} — ${data.geofenceName ?? 'geocerca'}`, severity);
    });

    socket.on('supervisor:signal_lost', (data) => {
      const key = `signal:${data.deviceId}`;
      if (data.level === 0) {
        resolveAlert(key);
      } else if (data.level === 1) {
        upsertAlert(key, `Vehículo ${data.deviceId} sin señal (${data.elapsedSeconds}s)`, 'warning');
      } else {
        upsertAlert(key, `Vehículo ${data.deviceId} sin señal — emergencia`, 'danger');
      }
    });

    socket.on('supervisor:collision', (data) => {
      const key = pairKey('collision', data.deviceId1, data.deviceId2);
      if (data.level === 0) {
        resolveAlert(key);
        return;
      }
      upsertAlert(
        key,
        `Colisión ${data.level === 2 ? 'inminente' : 'próxima'} — V${data.deviceId1} y V${data.deviceId2} a ${data.distance}m`,
        data.level === 2 ? 'danger' : 'warning',
      );
    });

    socket.on('supervisor:proximity', (data) => {
      const key = pairKey('proximity', data.deviceId1, data.deviceId2);
      if (data.level === 0) {
        resolveAlert(key);
        return;
      }
      upsertAlert(
        key,
        `Proximidad fuera de ruta — V${data.deviceId1} y V${data.deviceId2} a ${data.distance}m`,
        data.level === 2 ? 'danger' : 'warning',
      );
    });

    socket.on('supervisor:preventive_stop', (data) => {
      const key = 'preventive_stop';
      if (data.active) {
        upsertAlert(key, `Parada preventiva activada — ${data.reason ?? ''}`, 'danger');
      } else {
        resolveAlert(key);
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
  }, [upsertAlert, resolveAlert]);

  const alerts = useMemo(
    () => Object.values(activeAlerts).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
    [activeAlerts],
  );
  const alertCount = alerts.length;

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
