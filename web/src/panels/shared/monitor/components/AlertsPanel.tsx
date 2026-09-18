import { AlertBanner } from '@gaga-gps/ui';
import type { InfractionRow } from '@gaga-gps/shared-types';
import { useState } from 'react';
import { NavIcon } from '../../components/NavIcons';
import type { AlertEntry } from '../useSupervisorSocket';
import { INCIDENT_CATEGORY_LABEL } from '../useSupervisorSocket';
import { useIncidentHistory } from '../useIncidentHistory';
import { useInfractionHistory } from '../useInfractionHistory';

type HistoryType = 'incidents' | 'infractions';
type IncidentStatusFilter = '' | 'open' | 'resolved';

const INFRACTION_TYPE_LABEL: Record<InfractionRow['infraction_type'], string> = {
  speed: 'Velocidad',
  geofence: 'Geocerca',
  collision: 'Colisión',
};

// colisión involucra 2 vehiculos (device_id_2) - los demas tipos solo uno
function infractionVehicleLabel(r: InfractionRow): string {
  const main = r.device_name ?? r.device_id;
  if (r.infraction_type === 'collision' && r.device_id_2) {
    return `${main} / ${r.device_2_name ?? r.device_id_2}`;
  }
  return main;
}

// 1-10, ver backend/src/utils/infractionSeverity.ts - verde/amarillo/rojo como referencia visual
// rapida, no un semaforo estricto de 3 niveles
function SeverityBadge({ value }: { value: number }) {
  const tone = value >= 8 ? 'danger' : value >= 5 ? 'warning' : 'info';
  return <span className={`sup-severity-${tone}`}>{value}</span>;
}

interface HistoryFilters {
  from: string;
  to: string;
  deviceId: string;
  personName: string;
  status: IncidentStatusFilter;
}

const EMPTY_HISTORY_FILTERS: HistoryFilters = { from: '', to: '', deviceId: '', personName: '', status: '' };

export interface AlertsPanelProps {
  alerts: AlertEntry[];
  alertCount: number;
  // sin esta prop, el boton "Resolver" nunca se renderiza - project_manager es solo lectura
  onResolveIncident?: (incidentId: number) => void;
  // sin esta prop, el boton "Marcar revisada" de Infracciones nunca se renderiza - mismo criterio
  // que onResolveIncident (project_manager es 100% solo lectura)
  canReviewInfractions?: boolean;
  // Encargado (project_manager) unicamente - cambia "Infracciones" (pestaña propia, solo hoy, sin
  // filtros) por un "Historial" unificado (Incidentes/Infracciones, filtrable libremente por fecha/
  // vehiculo/persona/estado) - pedido explicito: Supervisor solo ve "su turno" (hoy), sin acceso al
  // historial completo; un incidente ya activo se ve en "Activas" (sin cambios) hasta que se
  // resuelve, y a partir de ahi solo el Encargado puede volver a encontrarlo, en el Historial.
  canAccessHistory?: boolean;
}

export function AlertsPanel({
  alerts,
  alertCount,
  onResolveIncident,
  canReviewInfractions,
  canAccessHistory,
}: AlertsPanelProps) {
  const [alertsView, setAlertsView] = useState<'active' | 'infractions' | 'history'>('active');
  const [historyType, setHistoryType] = useState<HistoryType>('incidents');
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>(EMPTY_HISTORY_FILTERS);

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

  // Supervisor (sin canAccessHistory): pestaña propia "Infracciones", solo hoy, sin filtro alguno -
  // el backend ya fuerza el dia actual sin importar lo que se le pida
  function openInfractionsToday() {
    setAlertsView('infractions');
    searchInfractions();
  }

  // Encargado: "Historial" unificado - busca segun el tipo seleccionado (Incidentes/Infracciones)
  // con los filtros compartidos (el filtro "Estado" solo aplica a Incidentes)
  function runHistorySearch(type: HistoryType, filters: HistoryFilters) {
    if (type === 'incidents') {
      searchIncidents({
        from: filters.from,
        to: filters.to,
        deviceId: filters.deviceId,
        reportedByName: filters.personName,
        status: filters.status || undefined,
      });
    } else {
      searchInfractions({
        from: filters.from,
        to: filters.to,
        deviceId: filters.deviceId,
        operatorName: filters.personName,
      });
    }
  }

  function openHistory() {
    setAlertsView('history');
    runHistorySearch(historyType, historyFilters);
  }

  function changeHistoryType(type: HistoryType) {
    setHistoryType(type);
    runHistorySearch(type, historyFilters);
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
          {canAccessHistory ? (
            <button className={alertsView === 'history' ? 'active' : ''} onClick={openHistory}>
              Historial
            </button>
          ) : (
            <button className={alertsView === 'infractions' ? 'active' : ''} onClick={openInfractionsToday}>
              Infracciones
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

      {/* Supervisor - infracciones de hoy, sin filtros (el backend ya acota al dia actual) */}
      {alertsView === 'infractions' && !canAccessHistory && (
        <div className="sup-history-panel">
          {infractionsError && <div className="sup-alerts-empty">{infractionsError}</div>}
          <div className="sup-history-table-wrap">
            <table className="sup-history-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Operador</th>
                  <th>Vehículo</th>
                  <th>Tipo</th>
                  <th>Gravedad</th>
                  <th>Detalle</th>
                  <th>Revisada</th>
                  {canReviewInfractions && <th></th>}
                </tr>
              </thead>
              <tbody>
                {infractionsLoading ? (
                  <tr>
                    <td colSpan={canReviewInfractions ? 8 : 7}>Cargando…</td>
                  </tr>
                ) : infractionRows.length === 0 ? (
                  <tr>
                    <td colSpan={canReviewInfractions ? 8 : 7}>Sin infracciones hoy</td>
                  </tr>
                ) : (
                  infractionRows.map((r) => (
                    <tr key={r.id}>
                      <td>{new Date(r.occurred_at).toLocaleString('es-MX')}</td>
                      <td>{r.operator_name ?? '(sin turno activo)'}</td>
                      <td>{infractionVehicleLabel(r)}</td>
                      <td>{INFRACTION_TYPE_LABEL[r.infraction_type]}</td>
                      <td><SeverityBadge value={r.severity} /></td>
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

      {/* Encargado - historial unificado, filtrable libremente */}
      {alertsView === 'history' && canAccessHistory && (
        <div className="sup-history-panel">
          <div className="sup-alerts-toggle" style={{ marginBottom: 8 }}>
            <button
              className={historyType === 'incidents' ? 'active' : ''}
              onClick={() => changeHistoryType('incidents')}
            >
              Incidentes
            </button>
            <button
              className={historyType === 'infractions' ? 'active' : ''}
              onClick={() => changeHistoryType('infractions')}
            >
              Infracciones
            </button>
          </div>

          <div className="sup-history-filters">
            {historyType === 'incidents' && (
              <select
                value={historyFilters.status}
                onChange={(e) =>
                  setHistoryFilters({ ...historyFilters, status: e.target.value as IncidentStatusFilter })
                }
              >
                <option value="">Abiertos y resueltos</option>
                <option value="open">Solo abiertos (activos)</option>
                <option value="resolved">Solo resueltos</option>
              </select>
            )}
            <input
              placeholder="ID vehículo"
              value={historyFilters.deviceId}
              onChange={(e) => setHistoryFilters({ ...historyFilters, deviceId: e.target.value })}
            />
            <input
              placeholder={historyType === 'incidents' ? 'Reportado por' : 'Operador'}
              value={historyFilters.personName}
              onChange={(e) => setHistoryFilters({ ...historyFilters, personName: e.target.value })}
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
            <button className="sup-history-btn" onClick={() => runHistorySearch(historyType, historyFilters)}>
              Buscar
            </button>
          </div>

          {historyType === 'incidents' ? (
            <>
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
                        <td colSpan={6}>Sin resultados</td>
                      </tr>
                    ) : (
                      incidentRows.map((r) => (
                        <tr key={r.id}>
                          <td>{new Date(r.reported_at).toLocaleString('es-MX')}</td>
                          <td>{r.reported_by_name ?? '-'}</td>
                          <td>{r.device_name ?? r.device_id}</td>
                          <td>{INCIDENT_CATEGORY_LABEL[r.category]}</td>
                          <td>{r.message ?? '-'}</td>
                          <td>
                            {r.status === 'open'
                              ? 'Abierto'
                              : `Resuelto${r.resolved_by_name ? ` - ${r.resolved_by_name}` : ''}`}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <>
              {infractionsError && <div className="sup-alerts-empty">{infractionsError}</div>}
              <div className="sup-history-table-wrap">
                <table className="sup-history-table">
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Operador</th>
                      <th>Vehículo</th>
                      <th>Tipo</th>
                      <th>Gravedad</th>
                      <th>Detalle</th>
                      <th>Revisada</th>
                    </tr>
                  </thead>
                  <tbody>
                    {infractionsLoading ? (
                      <tr>
                        <td colSpan={7}>Cargando…</td>
                      </tr>
                    ) : infractionRows.length === 0 ? (
                      <tr>
                        <td colSpan={7}>Sin resultados</td>
                      </tr>
                    ) : (
                      infractionRows.map((r) => (
                        <tr key={r.id}>
                          <td>{new Date(r.occurred_at).toLocaleString('es-MX')}</td>
                          <td>{r.operator_name ?? '(sin turno activo)'}</td>
                          <td>{infractionVehicleLabel(r)}</td>
                          <td>{INFRACTION_TYPE_LABEL[r.infraction_type]}</td>
                          <td><SeverityBadge value={r.severity} /></td>
                          <td>{r.message}</td>
                          <td>{r.reviewed_at ? `Sí - ${new Date(r.reviewed_at).toLocaleDateString('es-MX')}` : 'No'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
