import {
  clearSession,
  createApiClient,
  createSocket,
  getStoredToken,
  goToLogin,
} from '@gaga-gps/client';
import type {
  ActiveMap,
  Geofence,
  IncidentCategory,
  IncidentReportedPayload,
  Position,
  PreventiveStopStatus,
  StaticEquipment,
} from '@gaga-gps/shared-types';
import type { EquipmentMarkerData } from '@gaga-gps/map-core';
import { useCallback, useEffect, useMemo, useState } from 'react';

export interface FleetVehicle extends Position {
  lastSeen: number;
}

function toMarkerData(eq: StaticEquipment): EquipmentMarkerData {
  return {
    id: eq.id,
    name: eq.name,
    latitude: eq.lat,
    longitude: eq.lon,
    swingRadiusMeters: eq.swingRadius,
    safetyRadiusMeters: eq.safetyRadius,
    linkedDeviceId: eq.linkedDeviceId,
  };
}

export interface AlertEntry {
  key: string;
  message: string;
  severity: 'danger' | 'warning' | 'info';
  since: string;
  incidentId?: number;
}

const SEVERITY_RANK: Record<AlertEntry['severity'], number> = { danger: 0, warning: 1, info: 2 };

export const INCIDENT_CATEGORY_LABEL: Record<IncidentCategory, string> = {
  obstacle: 'Objeto en el camino',
  accident: 'Accidente',
  traffic: 'Tráfico/bloqueo',
  other: 'Peligro reportado',
};

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
  const [equipment, setEquipment] = useState<EquipmentMarkerData[]>([]);
  const [activeMaps, setActiveMaps] = useState<ActiveMap[]>([]);
  const [activeAlerts, setActiveAlerts] = useState<Record<string, AlertEntry>>({});
  const [incidentMarkers, setIncidentMarkers] = useState<Record<number, IncidentReportedPayload>>({});
  const [stopStatus, setStopStatus] = useState<{ active: boolean; reason?: string }>({
    active: false,
  });

  const upsertAlert = useCallback(
    (
      key: string,
      message: string,
      severity: AlertEntry['severity'],
      incidentId?: number,
    ) => {
      setActiveAlerts((prev) => ({
        ...prev,
        [key]: {
          key,
          message,
          severity,
          incidentId,
          since: prev[key]?.since ?? new Date().toLocaleTimeString('es-MX'),
        },
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
    socket.on('equipment:update', (eqs: StaticEquipment[]) => setEquipment(eqs.map(toMarkerData)));

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

    // pedido explicito: geocercas/velocidad son avisos que solo debe ver el operador (si de verdad
    // cruza el limite ya queda registrado como infraccion permanente, ver pestaña "Infracciones") -
    // Supervisor/Encargado ya no los ven en vivo, para no llenar "Activas" de avisos que el propio
    // operador puede corregir a tiempo. 'power_loss' SI se mantiene (mismo canal generico
    // 'supervisor:alert', ver power-events.routes.ts) - es un estado de peligro directo, no un
    // aviso que se "cruza" progresivamente.
    socket.on('supervisor:alert', (data) => {
      if (data.type !== 'power_loss') return;
      const key = `power_loss:${data.deviceId}`;
      if (data.action !== 'entered') {
        resolveAlert(key);
        return;
      }
      upsertAlert(key, `Vehículo ${data.deviceId} perdió corriente fuera de zona autorizada`, 'danger');
    });

    socket.on('supervisor:signal_lost', (data) => {
      const key = `signal:${data.deviceId}`;
      if (data.level === 0) {
        resolveAlert(key);
      } else if (data.level === 1) {
        upsertAlert(key, `Vehículo ${data.deviceId} sin señal (${data.elapsedSeconds}s)`, 'warning');
      } else {
        upsertAlert(key, `Vehículo ${data.deviceId} sin señal - emergencia`, 'danger');
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
        `Colisión ${data.level === 2 ? 'inminente' : 'próxima'} - V${data.deviceId1} y V${data.deviceId2} a ${data.distance}m`,
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
        `Proximidad fuera de ruta - V${data.deviceId1} y V${data.deviceId2} a ${data.distance}m`,
        data.level === 2 ? 'danger' : 'warning',
      );
    });

    socket.on('incident:reported', (data) => {
      setIncidentMarkers((prev) => ({ ...prev, [data.id]: data }));
    });
    socket.on('incident:resolved', (data) => {
      setIncidentMarkers((prev) => {
        if (!(data.id in prev)) return prev;
        const next = { ...prev };
        delete next[data.id];
        return next;
      });
    });

    socket.on('supervisor:incident', (data) => {
      const key = `incident:${data.id}`;
      if (data.level === 0) {
        resolveAlert(key);
        return;
      }
      const categoryLabel = INCIDENT_CATEGORY_LABEL[data.category ?? 'other'] ?? 'Incidente';
      upsertAlert(
        key,
        `${categoryLabel}${data.deviceId ? ` - reportado por V${data.deviceId}` : ''}`,
        'warning',
        data.id,
      );
    });

    socket.on('alerts:snapshot', (entries) => {
      setActiveAlerts((prev) => {
        const next = { ...prev };
        entries.forEach((entry) => {
          if (next[entry.key]) return;
          next[entry.key] = {
            key: entry.key,
            message: entry.message,
            severity: entry.severity,
            since: new Date(entry.triggeredAt).toLocaleTimeString('es-MX'),
          };
        });
        return next;
      });
    });

    socket.on('supervisor:preventive_stop', (data) => {
      const key = 'preventive_stop';
      if (data.active) {
        upsertAlert(key, `Parada preventiva activada - ${data.reason ?? ''}`, 'danger');
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
  const incidents = useMemo(() => Object.values(incidentMarkers), [incidentMarkers]);

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

  const resolveIncident = useCallback(
    async (incidentId: number) => {
      await api.post(`/api/incidents/${incidentId}/resolve`);
      resolveAlert(`incident:${incidentId}`);
    },
    [resolveAlert],
  );

  return {
    connected,
    fleet,
    geofences,
    equipment,
    activeMaps,
    alerts,
    alertCount,
    incidents,
    stopStatus,
    activateStop,
    deactivateStop,
    resolveIncident,
  };
}
