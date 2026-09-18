import { clearSession, createApiClient, getStoredToken, goToLogin } from '@gaga-gps/client';
import type { GagaSocket } from '@gaga-gps/client';
import type {
  IncidentCategory,
  IncidentReportedPayload,
  IncidentResolvedPayload,
  PreventiveStopActivePayload,
  PreventiveStopStatus,
  SupervisorCollisionPayload,
  SupervisorGeofenceAlertPayload,
  SupervisorIncidentPayload,
  SupervisorProximityPayload,
  SupervisorPreventiveStopPayload,
  SupervisorSignalLostPayload,
  AlertEventEntry,
} from '@gaga-gps/shared-types';
import { useCallback, useEffect, useMemo, useState } from 'react';

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

// listeners de alertas/incidentes/parada preventiva, extraidos de useSupervisorSocket para poder
// reutilizarlos sobre un socket que el panel ya abrio por otro motivo (Admin ya tiene el suyo en
// DashboardSection.tsx) - nunca abrir un segundo socket.io por panel, cada conexion es su propio
// handshake JWT + heartbeat. Se le pasa el socket ya creado, este hook nunca lo crea ni lo cierra.
export function useAlertsFeed(socket: GagaSocket | null) {
  const [activeAlerts, setActiveAlerts] = useState<Record<string, AlertEntry>>({});
  const [incidentMarkers, setIncidentMarkers] = useState<Record<number, IncidentReportedPayload>>({});
  const [stopStatus, setStopStatus] = useState<{ active: boolean; reason?: string }>({
    active: false,
  });

  const upsertAlert = useCallback(
    (key: string, message: string, severity: AlertEntry['severity'], incidentId?: number) => {
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
    if (!socket) return;

    const onSupervisorAlert = (data: SupervisorGeofenceAlertPayload) => {
      if (data.type !== 'power_loss') return;
      const key = `power_loss:${data.deviceId}`;
      if (data.action !== 'entered') {
        resolveAlert(key);
        return;
      }
      upsertAlert(key, `Vehículo ${data.deviceId} perdió corriente fuera de zona autorizada`, 'danger');
    };

    const onSignalLost = (data: SupervisorSignalLostPayload) => {
      const key = `signal:${data.deviceId}`;
      if (data.level === 0) {
        resolveAlert(key);
      } else if (data.level === 1) {
        upsertAlert(key, `Vehículo ${data.deviceId} sin señal (${data.elapsedSeconds}s)`, 'warning');
      } else {
        upsertAlert(key, `Vehículo ${data.deviceId} sin señal - emergencia`, 'danger');
      }
    };

    const onCollision = (data: SupervisorCollisionPayload) => {
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
    };

    const onProximity = (data: SupervisorProximityPayload) => {
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
    };

    const onIncidentReported = (data: IncidentReportedPayload) => {
      setIncidentMarkers((prev) => ({ ...prev, [data.id]: data }));
    };

    const onIncidentResolved = (data: IncidentResolvedPayload) => {
      setIncidentMarkers((prev) => {
        if (!(data.id in prev)) return prev;
        const next = { ...prev };
        delete next[data.id];
        return next;
      });
    };

    const onSupervisorIncident = (data: SupervisorIncidentPayload) => {
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
    };

    const onAlertsSnapshot = (entries: AlertEventEntry[]) => {
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
    };

    const onPreventiveStop = (data: SupervisorPreventiveStopPayload) => {
      const key = 'preventive_stop';
      if (data.active) {
        upsertAlert(key, `Parada preventiva activada - ${data.reason ?? ''}`, 'danger');
      } else {
        resolveAlert(key);
      }
    };

    const onFleetStop = (data: PreventiveStopActivePayload) => {
      setStopStatus({ active: true, reason: data.reason });
    };

    const onFleetStopClear = () => setStopStatus({ active: false });

    socket.on('supervisor:alert', onSupervisorAlert);
    socket.on('supervisor:signal_lost', onSignalLost);
    socket.on('supervisor:collision', onCollision);
    socket.on('supervisor:proximity', onProximity);
    socket.on('incident:reported', onIncidentReported);
    socket.on('incident:resolved', onIncidentResolved);
    socket.on('supervisor:incident', onSupervisorIncident);
    socket.on('alerts:snapshot', onAlertsSnapshot);
    socket.on('supervisor:preventive_stop', onPreventiveStop);
    socket.on('fleet:preventive_stop', onFleetStop);
    socket.on('fleet:preventive_stop_clear', onFleetStopClear);

    return () => {
      socket.off('supervisor:alert', onSupervisorAlert);
      socket.off('supervisor:signal_lost', onSignalLost);
      socket.off('supervisor:collision', onCollision);
      socket.off('supervisor:proximity', onProximity);
      socket.off('incident:reported', onIncidentReported);
      socket.off('incident:resolved', onIncidentResolved);
      socket.off('supervisor:incident', onSupervisorIncident);
      socket.off('alerts:snapshot', onAlertsSnapshot);
      socket.off('supervisor:preventive_stop', onPreventiveStop);
      socket.off('fleet:preventive_stop', onFleetStop);
      socket.off('fleet:preventive_stop_clear', onFleetStopClear);
    };
  }, [socket, upsertAlert, resolveAlert]);

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
    alerts,
    alertCount,
    incidents,
    stopStatus,
    activateStop,
    deactivateStop,
    resolveIncident,
  };
}
