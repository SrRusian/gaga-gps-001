import { clearSession, getStoredUser } from '@gaga-gps/client';
import { useMapMode } from '@gaga-gps/map-core';
import {
  AlertBanner,
  Button,
  ConnectionStatusDot,
  MapModeSelector,
  StatCard,
  VehicleCard,
} from '@gaga-gps/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './supervisor.css';
import { MapView, type MapViewHandle } from './MapView';
import { useSupervisorSocket } from './useSupervisorSocket';

const OFFLINE_THRESHOLD_MS = 45000;

// ProtectedRoute (features/auth) ya garantizó una sesión válida con
// rol "supervisor" antes de montar este componente.
export default function SupervisorApp() {
  const navigate = useNavigate();
  const user = getStoredUser()!;
  const {
    connected,
    fleet,
    geofences,
    activeMaps,
    alerts,
    alertCount,
    stopStatus,
    activateStop,
    deactivateStop,
  } = useSupervisorSocket();
  const [mapMode, setMapMode] = useMapMode('gaga_supervisor_map_mode');
  const [selectedVehicle, setSelectedVehicle] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const mapRef = useRef<MapViewHandle>(null);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  function logout() {
    clearSession();
    navigate('/', { replace: true });
  }

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

  return (
    <div className="sup-app">
      <header className="sup-header">
        <h1>🛰️ GAGA GPS — Panel de Supervisión</h1>
        <div className="sup-header-right">
          <span>{now.toLocaleTimeString('es-MX')}</span>
          <div className="sup-connection">
            <ConnectionStatusDot connected={connected} />
            <span>{connected ? 'Conectado' : 'Desconectado'}</span>
          </div>
          <span>{user.name}</span>
          <button className="sup-logout-btn" onClick={logout}>
            Salir
          </button>
        </div>
      </header>

      <div className="sup-main">
        <aside className="sup-left-panel">
          <div className="sup-dashboard">
            <StatCard label="Total" value={vehicles.length} />
            <StatCard label="En línea" value={onlineCount} />
            <StatCard label="Alertas" value={alertCount} variant="alert" />
            <StatCard label="Sin señal" value={offlineCount} variant="warning" />
          </div>

          <div className="sup-stop-section">
            {!stopStatus.active ? (
              <Button variant="danger" className="sup-stop-btn" onClick={handleActivateStop}>
                🛑 PARADA PREVENTIVA COLECTIVA
              </Button>
            ) : (
              <Button
                variant="primary"
                className="sup-stop-btn"
                style={{ background: '#00aa44' }}
                onClick={handleDeactivateStop}
              >
                ✅ REANUDAR OPERACIÓN
              </Button>
            )}
            <div className={`sup-stop-status${stopStatus.active ? ' active' : ''}`}>
              {stopStatus.active
                ? `🛑 ACTIVA${stopStatus.reason ? ` — ${stopStatus.reason}` : ''}`
                : 'Sistema en operación normal'}
            </div>
          </div>

          <div className="sup-alerts-section">
            <div className="sup-section-header">Alertas recientes</div>
            {alerts.length === 0 ? (
              <div className="sup-alerts-empty">Sin alertas activas</div>
            ) : (
              alerts.map((a) => (
                <AlertBanner key={a.id} severity={a.severity} message={a.message} time={a.time} />
              ))
            )}
          </div>

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
        </aside>

        <div className="sup-map-container">
          <div className="sup-map-mode-selector-wrap">
            <MapModeSelector mode={mapMode} onChange={setMapMode} />
          </div>

          <MapView
            ref={mapRef}
            fleet={fleet}
            geofences={geofences}
            activeMaps={activeMaps}
            mapMode={mapMode}
            onVehicleClick={selectVehicle}
          />

          {detail && (
            <div className="sup-vehicle-detail">
              <div className="sup-detail-title">
                <span>
                  {detail.deviceName
                    ? `${detail.deviceName}${detail.deviceType ? ` (${detail.deviceType})` : ''}`
                    : `Vehículo ${detail.deviceId}`}
                </span>
                <button className="sup-btn-close" onClick={() => setSelectedVehicle(null)}>
                  ✕
                </button>
              </div>
              <div className="sup-detail-row">
                <span className="sup-detail-label">Estado</span>
                <span className="sup-detail-value">
                  {detailOffline ? '🔴 Sin señal' : '🟢 En línea'}
                </span>
              </div>
              <div className="sup-detail-row">
                <span className="sup-detail-label">Velocidad</span>
                <span className="sup-detail-value">
                  {Math.round((detail.speed || 0) * 3.6)} km/h
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
                <span className="sup-detail-label">Última actualización</span>
                <span className="sup-detail-value">
                  {new Date(detail.fixTime || Date.now()).toLocaleTimeString('es-MX')}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
