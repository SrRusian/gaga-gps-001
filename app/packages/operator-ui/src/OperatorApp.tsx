import { clearSession, getStoredUser } from '@gaga-gps/client';
import { haversineMeters, useMapMode } from '@gaga-gps/map-core';
import type { Position } from '@gaga-gps/shared-types';
import { ConnectionStatusDot, MapModeSelector } from '@gaga-gps/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './operator.css';
import { DeviceSetupOverlay } from './DeviceSetupOverlay';
import { MapView, type MapViewHandle } from './MapView';
import { OperatorLoginOverlay } from './OperatorLoginOverlay';
import { ReportIncidentOverlay } from './ReportIncidentOverlay';
import { useBatteryLevel } from './useBatteryLevel';
import { useDeviceGeolocation } from './useDeviceGeolocation';
import { useDeviceSensorReporter } from './useDeviceSensorReporter';
import { useDeviceId } from './useDeviceId';
import { useIncidentReporter } from './useIncidentReporter';
import { useOperatorAuth } from './useOperatorAuth';
import { useOperatorSocket } from './useOperatorSocket';

const AUTO_FOLLOW_STORAGE_KEY = 'gaga_operator_auto_follow';
const THREAT_FRAME_HOLD_MS = 8000;

function useAutoFollow(): [boolean, (next: boolean) => void] {
  const [autoFollow, setAutoFollowState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const stored = localStorage.getItem(AUTO_FOLLOW_STORAGE_KEY);
    return stored === null ? true : stored === 'true';
  });

  const setAutoFollow = useCallback((next: boolean) => {
    setAutoFollowState(next);
    localStorage.setItem(AUTO_FOLLOW_STORAGE_KEY, String(next));
  }, []);

  return [autoFollow, setAutoFollow];
}

export default function OperatorApp() {
  const navigate = useNavigate();
  const user = getStoredUser()!;
  const { deviceId, saveDeviceSetup, error: deviceError, verifying } = useDeviceId();
  const { session, operatingEquipment, needsShiftStart, shiftStartError, checking, startShift, endShift } =
    useOperatorAuth(deviceId);
  const {
    connected,
    activeCount,
    geofences,
    equipment,
    activeMaps,
    fleet,
    alert,
    nearestVehicle,
    threat,
    activeGeofenceId,
    incidents,
  } = useOperatorSocket(deviceId);
  const [mapMode, setMapMode] = useMapMode('gaga_operator_map_mode');
  const [autoFollow, setAutoFollow] = useAutoFollow();
  const [framingThreat, setFramingThreat] = useState(false);
  const [showReportIncident, setShowReportIncident] = useState(false);
  const mapRef = useRef<MapViewHandle>(null);
  const { report: reportIncident, submitting: reportingIncident, error: reportIncidentError } =
    useIncidentReporter(deviceId);

  const { position: localGeo, error: geoError, supported: geoSupported } = useDeviceGeolocation();
  const batteryLevel = useBatteryLevel();
  useDeviceSensorReporter(deviceId);

  // posición propia: local tiene prioridad sobre servidor; alertas siguen siendo del servidor
  const displayFleet = useMemo(() => {
    if (!deviceId || !localGeo) return fleet;
    const base = fleet[deviceId];
    const merged: Position = {
      deviceId,
      latitude: localGeo.latitude,
      longitude: localGeo.longitude,
      speed: localGeo.speed ?? base?.speed,
      course: localGeo.heading ?? base?.course,
      accuracy: localGeo.accuracy ?? base?.accuracy,
      altitude: localGeo.altitude ?? base?.altitude,
      fixTime: new Date(localGeo.timestamp).toISOString(),
      deviceName: base?.deviceName,
      deviceType: base?.deviceType,
    };
    return { ...fleet, [deviceId]: merged };
  }, [fleet, deviceId, localGeo]);

  const myDisplay = deviceId ? (displayFleet[deviceId] ?? null) : null;

  const liveNearest = useMemo(() => {
    if (!myDisplay) return null;
    let best: { deviceId: string; distanceM: number; stale: boolean } | null = null;
    for (const pos of Object.values(displayFleet)) {
      if (pos.deviceId === deviceId) continue;
      const distanceM = haversineMeters(
        myDisplay.latitude,
        myDisplay.longitude,
        pos.latitude,
        pos.longitude,
      );
      if (!best || distanceM < best.distanceM) {
        const ageMs = Date.now() - new Date(pos.fixTime).getTime();
        best = { deviceId: pos.deviceId, distanceM, stale: ageMs > 10000 };
      }
    }
    return best;
  }, [myDisplay, displayFleet, deviceId]);

  const [showDeviceSetup, setShowDeviceSetup] = useState(!deviceId);

  useEffect(() => {
    if (!myDisplay || !autoFollow || framingThreat) return;
    mapRef.current?.follow(myDisplay.latitude, myDisplay.longitude, myDisplay.course, myDisplay.speed);
  }, [myDisplay, autoFollow, framingThreat]);

  useEffect(() => {
    if (!threat || !myDisplay) {
      setFramingThreat(false);
      return;
    }
    const other = fleet[threat.deviceId];
    if (!other) return;

    setFramingThreat(true);
    mapRef.current?.frameThreat(
      [myDisplay.longitude, myDisplay.latitude],
      [other.longitude, other.latitude],
    );
    const timeout = setTimeout(() => setFramingThreat(false), THREAT_FRAME_HOLD_MS);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threat]);

  function centerOnMyPosition() {
    if (myDisplay) mapRef.current?.flyTo(myDisplay.latitude, myDisplay.longitude);
    setAutoFollow(true);
  }

  async function handleReportIncident(category: Parameters<typeof reportIncident>[0], message: string) {
    if (!myDisplay) return;
    const ok = await reportIncident(category, message, myDisplay.latitude, myDisplay.longitude);
    if (ok) setShowReportIncident(false);
  }

  function logout() {
    clearSession();
    navigate('/', { replace: true });
  }

  const deviceName = myDisplay?.deviceName
    ? `${myDisplay.deviceName}${myDisplay.deviceType ? ` (${myDisplay.deviceType})` : ''}`
    : (deviceId ?? 'Sin vehículo asignado');

  return (
    <div className="op-app">
      <header className="op-header">
        <div className="op-header-row">
          <div className="op-identity">
            <span id="op-device-name">{deviceName}</span>
            <span id="op-operator-name">{user.name}</span>
            {operatingEquipment && (
              <span id="op-equipment-badge" title="Este dispositivo opera equipo estático fijo, no un vehículo">
                Operando: {operatingEquipment.name} ({operatingEquipment.type})
              </span>
            )}
          </div>
          <div className="op-header-actions">
            {deviceId && (
              <span id="op-vehicle-count">
                {activeCount} vehículo{activeCount !== 1 ? 's' : ''}
              </span>
            )}
            {!deviceId && (
              <button className="op-btn" onClick={() => setShowDeviceSetup(true)}>
                Registrar vehículo
              </button>
            )}
            {session && (
              <button className="op-btn op-btn--danger" onClick={endShift}>
                Finalizar turno
              </button>
            )}
            <button className="op-btn op-btn--danger" onClick={logout}>
              Cerrar sesión
            </button>
          </div>
        </div>
        <div className="op-header-row op-status-row">
          <span className="op-status-chip">
            <ConnectionStatusDot connected={connected} />
            {connected ? 'Conectado' : 'Sin conexión'}
          </span>
          <span className="op-status-chip">
            <ConnectionStatusDot connected={!!localGeo} />
            {geoSupported ? (localGeo ? 'GPS local' : 'GPS sin señal') : 'GPS no disponible'}
            {geoError && <span id="op-gps-error"> ({geoError})</span>}
          </span>
        </div>
      </header>

      {!checking && myDisplay && (
        <>
          <div className="op-map-area">
            <MapView
              ref={mapRef}
              fleet={displayFleet}
              geofences={geofences}
              incidents={Object.values(incidents)}
              equipment={equipment}
              activeMaps={activeMaps}
              mapMode={mapMode}
              myDeviceId={deviceId}
              threatDeviceId={
                threat?.deviceId ??
                (nearestVehicle && nearestVehicle.distance <= 80 ? nearestVehicle.deviceId : null)
              }
              highlightedGeofenceId={activeGeofenceId}
              initialCenter={[myDisplay.longitude, myDisplay.latitude]}
              onUserInteraction={() => setAutoFollow(false)}
            />

            <div className="op-map-mode-selector-wrap">
              <MapModeSelector mode={mapMode} onChange={setMapMode} />
            </div>

            {}
            {deviceId && (
              <div className="op-floating-actions">
                <button
                  className={`op-fab${autoFollow ? ' active' : ''}`}
                  onClick={centerOnMyPosition}
                  title={autoFollow ? 'Siguiendo mi posición' : 'Centrar y seguir mi posición'}
                  aria-label="Centrar y seguir mi posición"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="3" />
                    <line x1="12" y1="2" x2="12" y2="6" />
                    <line x1="12" y1="18" x2="12" y2="22" />
                    <line x1="2" y1="12" x2="6" y2="12" />
                    <line x1="18" y1="12" x2="22" y2="12" />
                  </svg>
                </button>
                <button
                  className="op-fab op-fab--warning"
                  onClick={() => setShowReportIncident(true)}
                  title="Reportar peligro"
                  aria-label="Reportar peligro"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 3 L21 19 H3 Z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="16" x2="12" y2="16.01" />
                  </svg>
                </button>
              </div>
            )}
          </div>

          {}
          {deviceId && (
            <footer id="op-info-bar">
              <div className="op-info-item">
                <span className="op-info-label">Velocidad</span>
                <span className="op-info-value">
                  {Math.round((myDisplay?.speed ?? 0) * 3.6)} km/h
                </span>
              </div>
              <div className="op-info-item">
                <span className="op-info-label">Más cercano</span>
                <span className="op-info-value">
                  {liveNearest ? `${Math.round(liveNearest.distanceM)} m` : '--'}
                  {liveNearest?.stale && <span id="op-nearest-stale"> (sin señal)</span>}
                </span>
              </div>
              {batteryLevel !== null && (
                <div className="op-info-item">
                  <span className="op-info-label">Batería</span>
                  <span className="op-info-value">{batteryLevel}%</span>
                </div>
              )}
            </footer>
          )}
        </>
      )}
      {!checking && !myDisplay && (
        <div className="op-map-loading">Obteniendo tu ubicación...</div>
      )}

      {}
      <div
        id="op-alert-overlay"
        className={alert.severity === 'info' ? '' : (alert.severity ?? '')}
      />
      <div id="op-alert-message" className={alert.severity ?? ''}>
        {alert.message}
      </div>

      {showDeviceSetup && (
        <DeviceSetupOverlay
          onSave={saveDeviceSetup}
          onClose={() => setShowDeviceSetup(false)}
          error={deviceError}
          verifying={verifying}
        />
      )}
      {deviceId && needsShiftStart && (
        <OperatorLoginOverlay onStartShift={startShift} error={shiftStartError} />
      )}
      {showReportIncident && (
        <ReportIncidentOverlay
          onSubmit={handleReportIncident}
          onClose={() => setShowReportIncident(false)}
          error={reportIncidentError}
          submitting={reportingIncident}
        />
      )}
    </div>
  );
}
