import { clearSession, getStoredUser } from '@gaga-gps/client';
import { useMapMode } from '@gaga-gps/map-core';
import { ConnectionStatusDot, MapModeSelector } from '@gaga-gps/ui';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './operator.css';
import { DeviceSetupOverlay } from './DeviceSetupOverlay';
import { MapView, type MapViewHandle } from './MapView';
import { OperatorLoginOverlay } from './OperatorLoginOverlay';
import { useDeviceId } from './useDeviceId';
import { useOperatorAuth } from './useOperatorAuth';
import { useOperatorSocket } from './useOperatorSocket';

// ProtectedRoute (features/auth) ya garantizó una sesión válida con
// rol "operator" antes de montar este componente.
export default function OperatorApp() {
  const navigate = useNavigate();
  // Identidad de la cuenta (login único) — independiente de si ya
  // hay turno activo (`session`, más abajo) o no. Se muestra siempre;
  // "session" en cambio solo existe una vez que el turno arrancó.
  const user = getStoredUser()!;
  const { deviceId, saveDeviceSetup, error: deviceError, verifying } = useDeviceId();
  const { session, needsShiftStart, shiftStartError, checking, startShift, endShift } =
    useOperatorAuth(deviceId);
  const { connected, activeCount, geofences, activeMaps, fleet, myPosition, myOnline, alert } =
    useOperatorSocket(deviceId);
  const [mapMode, setMapMode] = useMapMode('gaga_operator_map_mode');
  const mapRef = useRef<MapViewHandle>(null);
  const hasCenteredRef = useRef(false);

  // Se abre sola si todavía no hay vehículo asignado; el operador
  // puede cerrarla para ver el mapa (vacío) y volver a abrirla
  // después con "Registrar vehículo" en la barra superior.
  const [showDeviceSetup, setShowDeviceSetup] = useState(!deviceId);

  // Auto-centrar al recibir la primera posición propia.
  useEffect(() => {
    if (myPosition && !hasCenteredRef.current) {
      hasCenteredRef.current = true;
      mapRef.current?.flyTo(myPosition.latitude, myPosition.longitude);
    }
  }, [myPosition]);

  function centerOnMyPosition() {
    if (myPosition) mapRef.current?.flyTo(myPosition.latitude, myPosition.longitude);
  }

  function logout() {
    // Cierra la sesión de la cuenta (login único) — distinto de
    // "Finalizar turno", que solo cierra el turno del vehículo y
    // mantiene la sesión iniciada.
    clearSession();
    navigate('/', { replace: true });
  }

  const deviceName = myPosition?.deviceName
    ? `${myPosition.deviceName}${myPosition.deviceType ? ` (${myPosition.deviceType})` : ''}`
    : (deviceId ?? 'Sin vehículo asignado');

  return (
    <div className="op-app">
      <div id="op-status-bar">
        <div id="op-device-name">{deviceName}</div>
        <div id="op-connection-status">
          <ConnectionStatusDot connected={connected} />
          <span>{connected ? 'Conectado' : 'Sin conexión'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span id="op-operator-name">👤 {user.name}</span>
          {!deviceId && (
            <button id="op-btn-register-device" onClick={() => setShowDeviceSetup(true)}>
              Registrar vehículo
            </button>
          )}
          {session && (
            <button id="op-btn-end-shift" onClick={endShift}>
              Finalizar turno
            </button>
          )}
          <button id="op-btn-logout" onClick={logout}>
            Cerrar sesión
          </button>
          {deviceId && (
            <div id="op-vehicle-count">
              {activeCount} vehículo{activeCount !== 1 ? 's' : ''}
            </div>
          )}
        </div>
      </div>

      {!checking && (
        <>
          <div id="op-map-container">
            <MapView
              ref={mapRef}
              fleet={fleet}
              geofences={geofences}
              activeMaps={activeMaps}
              mapMode={mapMode}
              myDeviceId={deviceId}
            />
          </div>

          <div id="op-map-mode-selector-wrap">
            <MapModeSelector mode={mapMode} onChange={setMapMode} />
          </div>

          {/* Sin vehículo registrado no hay "mi posición", flota,
              alertas ni geocercas — solo el mapa base — así que el
              resto de la barra de información no aplica. */}
          {deviceId && (
            <>
              <button id="op-btn-center" onClick={centerOnMyPosition} title="Centrar en mi posición">
                ⊙
              </button>

              <div id="op-info-bar">
                <div className="op-info-item">
                  <span className="op-info-label">Velocidad</span>
                  <span className="op-info-value">
                    {Math.round((myPosition?.speed ?? 0) * 3.6)} km/h
                  </span>
                </div>
                <div className="op-info-item">
                  <span className="op-info-label">Latitud</span>
                  <span className="op-info-value">{myPosition?.latitude?.toFixed(5) ?? '--'}</span>
                </div>
                <div className="op-info-item">
                  <span className="op-info-label">Longitud</span>
                  <span className="op-info-value">{myPosition?.longitude?.toFixed(5) ?? '--'}</span>
                </div>
                <div className="op-info-item">
                  <span className="op-info-label">Estado</span>
                  <span className="op-info-value">{myOnline ? '🟢 En línea' : '🔴 Offline'}</span>
                </div>
              </div>
            </>
          )}
        </>
      )}

      <div id="op-alert-overlay" className={alert.severity ?? ''} />
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
    </div>
  );
}
