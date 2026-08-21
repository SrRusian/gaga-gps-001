import { clearSession, getStoredUser, roleLabel } from '@gaga-gps/client';
import { useMapMode } from '@gaga-gps/map-core';
import type { AlertEventType } from '@gaga-gps/shared-types';
import {
  AlertBanner,
  Button,
  ConnectionStatusDot,
  formatAccuracy,
  MapModeSelector,
  PanelHeader,
  StatCard,
  VehicleCard,
} from '@gaga-gps/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './supervisor.css';
import { MapView, type MapViewHandle } from './MapView';
import { useActiveOperatorSession } from './useActiveOperatorSession';
import { EMPTY_FILTERS, useAlertHistory } from './useAlertHistory';
import { useMyShift } from './useMyShift';
import { useSupervisorSocket } from './useSupervisorSocket';

const OFFLINE_THRESHOLD_MS = 45000;

const ALERT_TYPE_LABEL: Record<AlertEventType, string> = {
  geofence: 'Geocerca',
  signal_lost: 'Señal perdida',
  collision: 'Colisión',
  proximity: 'Proximidad',
  preventive_stop: 'Parada preventiva',
  incident: 'Incidente',
};

const SEVERITY_LABEL = { info: 'Info', warning: 'Precaución', danger: 'Peligro' } as const;

function formatDuration(from: string, to: string): string {
  const seconds = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export default function SupervisorApp() {
  const navigate = useNavigate();
  const user = getStoredUser()!;
  const isProjectSupervisor = user.role === 'project_supervisor';
  const {
    connected,
    fleet: fullFleet,
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
  } = useSupervisorSocket();
  const [mapMode, setMapMode] = useMapMode('gaga_supervisor_map_mode');
  const [selectedVehicle, setSelectedVehicle] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const mapRef = useRef<MapViewHandle>(null);

  const [alertsView, setAlertsView] = useState<'active' | 'history'>('active');
  const [historyFilters, setHistoryFilters] = useState(EMPTY_FILTERS);
  const { rows: historyRows, loading: historyLoading, error: historyError, search: searchHistory, exportCsv } =
    useAlertHistory();

  function openHistory() {
    setAlertsView('history');
    searchHistory(historyFilters);
  }

  const myShiftDeviceIds = useMyShift(isProjectSupervisor);
  const fleet = useMemo(() => {
    if (!myShiftDeviceIds) return fullFleet;
    return Object.fromEntries(
      Object.entries(fullFleet).filter(([deviceId]) => myShiftDeviceIds.has(deviceId)),
    );
  }, [fullFleet, myShiftDeviceIds]);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  function logout() {
    clearSession();
    navigate('/', { replace: true });
  }

  const hasMaps = activeMaps.length > 0;
  const vehicles = useMemo(() => Object.values(fleet), [fleet]);
  const offlineCount = vehicles.filter(
    (v) => now.getTime() - v.lastSeen > OFFLINE_THRESHOLD_MS,
  ).length;
  const onlineCount = vehicles.length - offlineCount;

  function selectVehicle(deviceId: string) {
    setSelectedVehicle(deviceId);
    const v = fleet[deviceId];
    if (v) mapRef.current?.flyTo(v.latitude, v.longitude);
  }

  async function handleActivateStop() {
    if (
      !confirm(
        '¿Confirma la activación de la PARADA PREVENTIVA COLECTIVA?\nTodos los vehículos recibirán la orden de detenerse.',
      )
    )
      return;
    await activateStop();
  }

  async function handleDeactivateStop() {
    if (
      !confirm(
        '¿Confirma la reanudación de operaciones?\nAsegúrese de que la situación de emergencia ha sido resuelta.',
      )
    )
      return;
    await deactivateStop();
  }

  const detail = selectedVehicle ? fleet[selectedVehicle] : null;
  const detailOffline = detail ? now.getTime() - detail.lastSeen > OFFLINE_THRESHOLD_MS : false;
  const activeSession = useActiveOperatorSession(selectedVehicle);

  return (
    <div className="sup-app">
      <PanelHeader
        connected={connected}
        userName={user.name}
        userRoleLabel={roleLabel(user.role)}
        onLogout={logout}
      />{}

      <main className="sup-float-main">
        <div className="sup-map-bg">
          <MapView
            ref={mapRef}
            fleet={fleet}
            geofences={geofences}
            incidents={incidents}
            equipment={equipment}
            activeMaps={activeMaps}
            mapMode={mapMode}
            onVehicleClick={selectVehicle}
          />
        </div>

        <div className="sup-left-stack">
          <div className="sup-stop-section sup-glass">
            {isProjectSupervisor &&
              (!stopStatus.active ? (
                <Button variant="danger" className="sup-stop-btn" onClick={handleActivateStop}>
                  Parada preventiva colectiva
                </Button>
              ) : (
                <Button variant="primary" className="sup-stop-btn" onClick={handleDeactivateStop}>
                  Reanudar operación
                </Button>
              ))}
            <div className={`sup-stop-status${stopStatus.active ? ' active' : ''}`}>
              {stopStatus.active
                ? `Activa${stopStatus.reason ? ` - ${stopStatus.reason}` : ''}`
                : 'Sistema en operación normal'}
            </div>
          </div>

          <div className="sup-alerts-section sup-glass">
            <div className="sup-section-header sup-alerts-header">
              <span>Alertas{alertsView === 'active' && alertCount > 0 ? ` (${alertCount})` : ''}</span>
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
                        isProjectSupervisor && a.incidentId !== undefined
                          ? () => resolveIncident(a.incidentId!)
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
                            <td>
                              {r.resolved_at ? formatDuration(r.triggered_at, r.resolved_at) : 'Activa'}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="sup-right-stack">
          <MapModeSelector mode={mapMode} onChange={setMapMode} satelliteAvailable={hasMaps} />

          {!hasMaps && (
            <div className="gg-no-maps-banner">
              <span>
                No hay ningún mapa satelital importado todavía para tu proyecto - los modos
                Satelital/Mixto no mostrarán nada (Calles sigue disponible).
              </span>
            </div>
          )}

          <div className="sup-vehicle-panel sup-glass">
            <div className="sup-section-header">Vehículos registrados</div>
            <div className="sup-vehicle-list">
              {vehicles.map((v) => {
                const isOffline = now.getTime() - v.lastSeen > OFFLINE_THRESHOLD_MS;
                return (
                  <VehicleCard
                    key={v.deviceId}
                    name={v.deviceName || `Vehículo ${v.deviceId}`}
                    type={v.deviceType}
                    status={isOffline ? 'offline' : 'online'}
                    hasAlert={isOffline}
                    info={`${v.speed ? Math.round(v.speed * 3.6) : 0} km/h  |  ${v.latitude?.toFixed(5)}, ${v.longitude?.toFixed(5)}`}
                    onClick={() => selectVehicle(v.deviceId)}
                  />
                );
              })}
            </div>
          </div>
        </div>

        <div className="sup-bottom-left-stack">
          <div className="sup-stats sup-glass">
            <StatCard label="Total" value={vehicles.length} />
            <StatCard label="En línea" value={onlineCount} />
            <StatCard label="Alertas" value={alertCount} variant="alert" />
            <StatCard label="Sin señal" value={offlineCount} variant="warning" />
          </div>
        </div>

        {detail && (
            <div className="sup-vehicle-detail sup-glass">
              <div className="sup-detail-title">
                <span>
                  {detail.deviceName
                    ? `${detail.deviceName}${detail.deviceType ? ` (${detail.deviceType})` : ''}`
                    : `Vehículo ${detail.deviceId}`}
                </span>
                <button className="sup-btn-close" onClick={() => setSelectedVehicle(null)}>
                  X
                </button>
              </div>
              <div className="sup-detail-row">
                <span className="sup-detail-label">Estado</span>
                <span className="sup-detail-value sup-detail-status">
                  <ConnectionStatusDot connected={!detailOffline} />
                  {detailOffline ? 'Sin señal' : 'En línea'}
                </span>
              </div>
              <div className="sup-detail-row">
                <span className="sup-detail-label">Operador</span>
                <span className="sup-detail-value">
                  {activeSession ? activeSession.user_name : 'Sin turno abierto'}
                </span>
              </div>
              {activeSession && (
                <div className="sup-detail-row">
                  <span className="sup-detail-label">Turno iniciado</span>
                  <span className="sup-detail-value">
                    {new Date(activeSession.started_at).toLocaleString('es-MX')}
                  </span>
                </div>
              )}
              <div className="sup-detail-row">
                <span className="sup-detail-label">Velocidad</span>
                <span className="sup-detail-value">
                  {Math.round((detail.speed || 0) * 3.6)} km/h
                </span>
              </div>
              <div className="sup-detail-row">
                <span className="sup-detail-label">Rumbo</span>
                <span className="sup-detail-value">
                  {detail.course !== undefined ? `${Math.round(detail.course)}°` : '--'}
                </span>
              </div>
              <div className="sup-detail-row">
                <span className="sup-detail-label">Latitud</span>
                <span className="sup-detail-value">{detail.latitude?.toFixed(6)}</span>
              </div>
              <div className="sup-detail-row">
                <span className="sup-detail-label">Longitud</span>
                <span className="sup-detail-value">{detail.longitude?.toFixed(6)}</span>
              </div>
              <div className="sup-detail-row">
                <span className="sup-detail-label">Precisión GPS</span>
                <span className="sup-detail-value">{formatAccuracy(detail.accuracy)}</span>
              </div>
              <div className="sup-detail-row">
                <span className="sup-detail-label">Altitud</span>
                <span className="sup-detail-value">
                  {detail.altitude !== undefined ? `${Math.round(detail.altitude)} m` : '--'}
                </span>
              </div>
              <div className="sup-detail-row">
                <span className="sup-detail-label">Batería</span>
                <span className="sup-detail-value">
                  {detail.battery !== undefined && detail.battery !== null
                    ? `${Math.round(detail.battery)}%`
                    : '--'}
                </span>
              </div>
              <div className="sup-detail-row">
                <span className="sup-detail-label">Última actualización</span>
                <span className="sup-detail-value">
                  {new Date(detail.fixTime || Date.now()).toLocaleTimeString('es-MX')}
                </span>
              </div>
            </div>
        )}
      </main>
    </div>
  );
}
