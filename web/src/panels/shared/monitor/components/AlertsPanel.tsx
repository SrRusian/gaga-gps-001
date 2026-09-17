import { AlertBanner } from '@gaga-gps/ui';
import type { AlertEventType } from '@gaga-gps/shared-types';
import { useState } from 'react';
import { NavIcon } from '../../components/NavIcons';
import type { AlertEntry } from '../useSupervisorSocket';
import { INCIDENT_CATEGORY_LABEL } from '../useSupervisorSocket';
import { EMPTY_FILTERS, useAlertHistory } from '../useAlertHistory';
import { useIncidentHistory } from '../useIncidentHistory';
import { useInfractionHistory } from '../useInfractionHistory';

const ALERT_TYPE_LABEL: Record<AlertEventType, string> = {
  geofence: 'Geocerca',
  signal_lost: 'Señal perdida',
  collision: 'Colisión',
  proximity: 'Proximidad',
  preventive_stop: 'Parada preventiva',
  incident: 'Incidente',
  equipment_variable: 'Variable de equipo',
  speed: 'Velocidad',
  power_loss: 'Pérdida de energía',
};

const SEVERITY_LABEL = { info: 'Info', warning: 'Precaución', danger: 'Peligro' } as const;

function formatDuration(from: string, to: string): string {
  const seconds = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

type DateRangeFilters = { from: string; to: string };
const EMPTY_RANGE: DateRangeFilters = { from: '', to: '' };

// filtro de fecha compartido por Infracciones/Incidentes - solo se muestra a quien puede filtrar
// libremente (Encargado); Supervisor nunca lo ve, el backend ya lo acota a su dia actual solo
function DateRangeFilter({
  value,
  onChange,
  onSearch,
}: {
  value: DateRangeFilters;
  onChange: (next: DateRangeFilters) => void;
  onSearch: () => void;
}) {
  return (
    <div className="sup-history-filters">
      <input
        type="datetime-local"
        value={value.from}
        onChange={(e) => onChange({ ...value, from: e.target.value })}
      />
      <input
        type="datetime-local"
        value={value.to}
        onChange={(e) => onChange({ ...value, to: e.target.value })}
      />
      <button className="sup-history-btn" onClick={onSearch}>
        Buscar
      </button>
    </div>
  );
}

export interface AlertsPanelProps {
  alerts: AlertEntry[];
  alertCount: number;
  // sin esta prop, el boton "Resolver" nunca se renderiza - project_manager es solo lectura
  onResolveIncident?: (incidentId: number) => void;
  // sin esta prop, el boton "Marcar revisada" de Infracciones nunca se renderiza - mismo criterio
  // que onResolveIncident (project_manager es 100% solo lectura)
  canReviewInfractions?: boolean;
  // Encargado (project_manager) unicamente - habilita la pestaña "Historial" (alert_events tecnico)
  // y el filtro de fecha libre en Infracciones/Incidentes. Sin esta prop (Supervisor), esas dos
  // pestañas solo muestran el dia actual, sin filtro, y "Historial" no aparece - pedido explicito:
  // Supervisor solo ve "su turno" (por ahora, el dia calendario), nunca el historial completo.
  canAccessHistory?: boolean;
}

export function AlertsPanel({
  alerts,
  alertCount,
  onResolveIncident,
  canReviewInfractions,
  canAccessHistory,
}: AlertsPanelProps) {
  const [alertsView, setAlertsView] = useState<'active' | 'incidents' | 'infractions' | 'history'>('active');
  const [historyFilters, setHistoryFilters] = useState(EMPTY_FILTERS);
  const [incidentRange, setIncidentRange] = useState(EMPTY_RANGE);
  const [infractionRange, setInfractionRange] = useState(EMPTY_RANGE);

  const { rows: historyRows, loading: historyLoading, error: historyError, search: searchHistory, exportCsv } =
    useAlertHistory();
  const {
    rows: incidentRows,
    loading: incidentsLoading,
    error: incidentsError,
    search: searchIncidents,
  } = useIncidentHistory();
  const {
    rows: infractionRows,
    loading: infractionsLoading,
    error: infractionsError,
    search: searchInfractions,
    markReviewed,
  } = useInfractionHistory();

  function openHistory() {
    setAlertsView('history');
    searchHistory(historyFilters);
  }

  // sin canAccessHistory (Supervisor), nunca se manda from/to - el backend siempre acota al dia
  // actual sin importar lo que se le pida, este solo evita mandar un filtro que de todos modos se
  // ignoraria
  function openIncidents() {
    setAlertsView('incidents');
    searchIncidents(canAccessHistory ? incidentRange : undefined);
  }

  function openInfractions() {
    setAlertsView('infractions');
    searchInfractions(canAccessHistory ? infractionRange : undefined);
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
          <button className={alertsView === 'incidents' ? 'active' : ''} onClick={openIncidents}>
            Incidentes
          </button>
          <button className={alertsView === 'infractions' ? 'active' : ''} onClick={openInfractions}>
            Infracciones
          </button>
          {canAccessHistory && (
            <button className={alertsView === 'history' ? 'active' : ''} onClick={openHistory}>
              Historial
            </button>
          )}
        </div>
      </div>

      {alertsView === 'active' && (
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
      )}

      {alertsView === 'incidents' && (
        <div className="sup-history-panel">
          {canAccessHistory && (
            <DateRangeFilter
              value={incidentRange}
              onChange={setIncidentRange}
              onSearch={() => searchIncidents(incidentRange)}
            />
          )}
          {incidentsError && <div className="sup-alerts-empty">{incidentsError}</div>}
          <div className="sup-history-table-wrap">
            <table className="sup-history-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Reportado por</th>
                  <th>Vehículo</th>
                  <th>Categoría</th>
                  <th>Mensaje</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {incidentsLoading ? (
                  <tr>
                    <td colSpan={6}>Cargando…</td>
                  </tr>
                ) : incidentRows.length === 0 ? (
                  <tr>
                    <td colSpan={6}>{canAccessHistory ? 'Sin resultados' : 'Sin incidentes hoy'}</td>
                  </tr>
                ) : (
                  incidentRows.map((r) => (
                    <tr key={r.id}>
                      <td>{new Date(r.reported_at).toLocaleString('es-MX')}</td>
                      <td>{r.reported_by_name ?? '-'}</td>
                      <td>{r.device_name ?? r.device_id}</td>
                      <td>{INCIDENT_CATEGORY_LABEL[r.category]}</td>
                      <td>{r.message ?? '-'}</td>
                      <td>{r.status === 'open' ? 'Abierto' : `Resuelto${r.resolved_by_name ? ` - ${r.resolved_by_name}` : ''}`}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {alertsView === 'infractions' && (
        <div className="sup-history-panel">
          {canAccessHistory && (
            <DateRangeFilter
              value={infractionRange}
              onChange={setInfractionRange}
              onSearch={() => searchInfractions(infractionRange)}
            />
          )}
          {infractionsError && <div className="sup-alerts-empty">{infractionsError}</div>}
          <div className="sup-history-table-wrap">
            <table className="sup-history-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Operador</th>
                  <th>Vehículo</th>
                  <th>Tipo</th>
                  <th>Detalle</th>
                  <th>Revisada</th>
                  {canReviewInfractions && <th></th>}
                </tr>
              </thead>
              <tbody>
                {infractionsLoading ? (
                  <tr>
                    <td colSpan={canReviewInfractions ? 7 : 6}>Cargando…</td>
                  </tr>
                ) : infractionRows.length === 0 ? (
                  <tr>
                    <td colSpan={canReviewInfractions ? 7 : 6}>
                      {canAccessHistory ? 'Sin infracciones registradas' : 'Sin infracciones hoy'}
                    </td>
                  </tr>
                ) : (
                  infractionRows.map((r) => (
                    <tr key={r.id}>
                      <td>{new Date(r.occurred_at).toLocaleString('es-MX')}</td>
                      <td>{r.operator_name ?? '(sin turno activo)'}</td>
                      <td>{r.device_name ?? r.device_id}</td>
                      <td>{r.infraction_type === 'speed' ? 'Velocidad' : 'Geocerca'}</td>
                      <td>{r.message}</td>
                      <td>{r.reviewed_at ? `Sí - ${new Date(r.reviewed_at).toLocaleDateString('es-MX')}` : 'No'}</td>
                      {canReviewInfractions && (
                        <td>
                          {!r.reviewed_at && (
                            <button className="sup-history-btn" onClick={() => markReviewed(r.id)}>
                              Marcar revisada
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {alertsView === 'history' && canAccessHistory && (
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
