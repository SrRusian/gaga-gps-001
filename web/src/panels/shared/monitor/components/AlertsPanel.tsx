import { AlertBanner } from '@gaga-gps/ui';
import type { AlertEventType } from '@gaga-gps/shared-types';
import { useState } from 'react';
import { NavIcon } from '../../components/NavIcons';
import type { AlertEntry } from '../useSupervisorSocket';
import { EMPTY_FILTERS, useAlertHistory } from '../useAlertHistory';

const ALERT_TYPE_LABEL: Record<AlertEventType, string> = {
  geofence: 'Geocerca',
  signal_lost: 'Señal perdida',
  collision: 'Colisión',
  proximity: 'Proximidad',
  preventive_stop: 'Parada preventiva',
  incident: 'Incidente',
  equipment_variable: 'Variable de equipo',
  speed: 'Velocidad',
};

const SEVERITY_LABEL = { info: 'Info', warning: 'Precaución', danger: 'Peligro' } as const;

function formatDuration(from: string, to: string): string {
  const seconds = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface AlertsPanelProps {
  alerts: AlertEntry[];
  alertCount: number;
  // sin esta prop, el boton "Resolver" nunca se renderiza - project_manager es solo lectura
  onResolveIncident?: (incidentId: number) => void;
}

export function AlertsPanel({ alerts, alertCount, onResolveIncident }: AlertsPanelProps) {
  const [alertsView, setAlertsView] = useState<'active' | 'history'>('active');
  const [historyFilters, setHistoryFilters] = useState(EMPTY_FILTERS);
  const { rows: historyRows, loading: historyLoading, error: historyError, search: searchHistory, exportCsv } =
    useAlertHistory();

  function openHistory() {
    setAlertsView('history');
    searchHistory(historyFilters);
  }

  return (
    <div className="sup-alerts-section">
      <div className="sup-section-header sup-alerts-header">
        <span className="sup-section-title">
          <NavIcon name="bell" size={14} />
          Alertas{alertsView === 'active' && alertCount > 0 ? ` (${alertCount})` : ''}
        </span>
        <div className="sup-alerts-toggle">
          <button
            className={alertsView === 'active' ? 'active' : ''}
            onClick={() => setAlertsView('active')}
          >
            Activas
          </button>
          <button className={alertsView === 'history' ? 'active' : ''} onClick={openHistory}>
            Historial
          </button>
        </div>
      </div>

      {alertsView === 'active' ? (
        <div className="sup-alerts-list">
          {alerts.length === 0 ? (
            <div className="sup-alerts-empty">Sin alertas activas</div>
          ) : (
            alerts.map((a) => (
              <AlertBanner
                key={a.key}
                severity={a.severity}
                message={a.message}
                time={`Desde ${a.since}`}
                onResolve={
                  onResolveIncident && a.incidentId !== undefined
                    ? () => onResolveIncident(a.incidentId!)
                    : undefined
                }
              />
            ))
          )}
        </div>
      ) : (
        <div className="sup-history-panel">
          <div className="sup-history-filters">
            <select
              value={historyFilters.type}
              onChange={(e) =>
                setHistoryFilters({ ...historyFilters, type: e.target.value as AlertEventType | '' })
              }
            >
              <option value="">Todos los tipos</option>
              {Object.entries(ALERT_TYPE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              value={historyFilters.severity}
              onChange={(e) =>
                setHistoryFilters({
                  ...historyFilters,
                  severity: e.target.value as 'info' | 'warning' | 'danger' | '',
                })
              }
            >
              <option value="">Toda severidad</option>
              <option value="danger">Peligro</option>
              <option value="warning">Precaución</option>
              <option value="info">Info</option>
            </select>
            <input
              placeholder="ID dispositivo"
              value={historyFilters.deviceId}
              onChange={(e) => setHistoryFilters({ ...historyFilters, deviceId: e.target.value })}
            />
            <input
              type="datetime-local"
              value={historyFilters.from}
              onChange={(e) => setHistoryFilters({ ...historyFilters, from: e.target.value })}
            />
            <input
              type="datetime-local"
              value={historyFilters.to}
              onChange={(e) => setHistoryFilters({ ...historyFilters, to: e.target.value })}
            />
            <button className="sup-history-btn" onClick={() => searchHistory(historyFilters)}>
              Buscar
            </button>
            <button className="sup-history-btn" onClick={() => exportCsv(historyFilters)}>
              Exportar CSV
            </button>
          </div>

          {historyError && <div className="sup-alerts-empty">{historyError}</div>}

          <div className="sup-history-table-wrap">
            <table className="sup-history-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Tipo</th>
                  <th>Severidad</th>
                  <th>Dispositivo</th>
                  <th>Mensaje</th>
                  <th>Duración</th>
                </tr>
              </thead>
              <tbody>
                {historyLoading ? (
                  <tr>
                    <td colSpan={6}>Cargando…</td>
                  </tr>
                ) : historyRows.length === 0 ? (
                  <tr>
                    <td colSpan={6}>Sin resultados</td>
                  </tr>
                ) : (
                  historyRows.map((r) => (
                    <tr key={r.id}>
                      <td>{new Date(r.triggered_at).toLocaleString('es-MX')}</td>
                      <td>{ALERT_TYPE_LABEL[r.alert_type]}</td>
                      <td className={`sup-severity-${r.severity}`}>{SEVERITY_LABEL[r.severity]}</td>
                      <td>{[r.device_id, r.device_id_2].filter(Boolean).join(' / ') || '-'}</td>
                      <td>{r.message ?? '-'}</td>
                      <td>{r.resolved_at ? formatDuration(r.triggered_at, r.resolved_at) : 'Activa'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
