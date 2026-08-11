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
import { useBatteryLevel } from './useBatteryLevel';
import { useDeviceGeolocation } from './useDeviceGeolocation';
import { useDeviceSensorReporter } from './useDeviceSensorReporter';
import { useDeviceId } from './useDeviceId';
import { useOperatorAuth } from './useOperatorAuth';
import { useOperatorSocket } from './useOperatorSocket';

const AUTO_FOLLOW_STORAGE_KEY = 'gaga_operator_auto_follow';
// Cuánto se mantiene el mapa encuadrando la amenaza antes de retomar
// el auto-seguimiento normal, aunque la alerta siga activa — evita
// quedar encajado en el encuadre amplio indefinidamente.
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
  const {
    connected,
    activeCount,
    geofences,
    activeMaps,
    fleet,
    myOnline,
    alert,
    nearestVehicle,
    threat,
    activeGeofenceId,
  } = useOperatorSocket(deviceId);
  const [mapMode, setMapMode] = useMapMode('gaga_operator_map_mode');
  const [autoFollow, setAutoFollow] = useAutoFollow();
  const [framingThreat, setFramingThreat] = useState(false);
  const mapRef = useRef<MapViewHandle>(null);
  const hasCenteredRef = useRef(false);

  // GPS del navegador — Función Telemetría Local, sobrevive sin conexión al servidor.
  const { position: localGeo, error: geoError, supported: geoSupported } = useDeviceGeolocation();
  const batteryLevel = useBatteryLevel();
  // Función Telemetría Extendida — captura de sensores del navegador
  useDeviceSensorReporter(deviceId);

  // Fusión: mi propia posición viene del sensor local si está
  // disponible (siempre, online u offline); el resto de la flota
  // sigue viniendo del servidor. Sin esto, "yo" se congela al perder
  // el socket igual que cualquier otro vehículo.
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

  // Vecino más cercano — recalculado en el cliente con la posición
  // LOCAL propia (myDisplay, que ya prioriza el sensor del navegador
  // sobre el dato relevado por el servidor) contra la última posición
  // conocida de cada vehículo, esté online u offline. Es puramente
  // informativo para el HUD; la alerta de proximidad/colisión sigue
  // siendo la que dispara el servidor (`threat`, sin tocar) — no se
  // duplica lógica de seguridad, solo se adelanta el número que ve
  // el operador sin esperar al siguiente tick del servidor.
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

  // Se abre sola si todavía no hay vehículo asignado; el operador
  // puede cerrarla para ver el mapa (vacío) y volver a abrirla
  // después con "Registrar vehículo" en la barra superior.
  const [showDeviceSetup, setShowDeviceSetup] = useState(!deviceId);

  // Primera posición: centrado con zoom de "llegada" (flyTo). De ahí
  // en más, mientras el auto-seguimiento esté activo, se sigue con
  // `follow` (sin forzar zoom) — así no pelea con un zoom manual.
  useEffect(() => {
    if (!myDisplay) return;
    if (!hasCenteredRef.current) {
      hasCenteredRef.current = true;
      mapRef.current?.flyTo(myDisplay.latitude, myDisplay.longitude);
      return;
    }
    if (autoFollow && !framingThreat) {
      mapRef.current?.follow(myDisplay.latitude, myDisplay.longitude);
    }
  }, [myDisplay, autoFollow, framingThreat]);

  // Encuadra ambos vehículos cuando aparece una amenaza crítica
  // (colisión/proximidad fuera de ruta) — suspende el auto-seguimiento
  // normal mientras dura, para no pelear con el encuadre amplio.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- se dispara una sola vez por amenaza nueva (identidad de `threat`), no en cada tick de myDisplay/fleet
  }, [threat]);

  function centerOnMyPosition() {
    if (myDisplay) mapRef.current?.flyTo(myDisplay.latitude, myDisplay.longitude);
  }

  function logout() {
    // Cierra la sesión de la cuenta (login único) — distinto de
    // "Finalizar turno", que solo cierra el turno del vehículo y
    // mantiene la sesión iniciada.
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

      {!checking && (
        <>
          <div className="op-map-area">
            <MapView
              ref={mapRef}
              fleet={displayFleet}
              geofences={geofences}
              activeMaps={activeMaps}
              mapMode={mapMode}
              myDeviceId={deviceId}
              threatDeviceId={
                threat?.deviceId ??
                // Mismo umbral que VehicleProximityService.WARNING_METERS (backend) —
                // resalta al más cercano solo cuando ya está en rango de alerta,
                // no simplemente "visible" en el HUD.
                (nearestVehicle && nearestVehicle.distance <= 80 ? nearestVehicle.deviceId : null)
              }
              highlightedGeofenceId={activeGeofenceId}
              onUserInteraction={() => setAutoFollow(false)}
            />

            <div className="op-map-mode-selector-wrap">
              <MapModeSelector mode={mapMode} onChange={setMapMode} />
            </div>

            {/* Sin vehículo registrado no hay "mi posición" que centrar/seguir. */}
            {deviceId && (
              <div className="op-floating-actions">
                <button
                  className="op-fab"
                  onClick={centerOnMyPosition}
                  title="Centrar en mi posición"
                  aria-label="Centrar en mi posición"
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
                  className={`op-fab${autoFollow ? ' active' : ''}`}
                  onClick={() => setAutoFollow(!autoFollow)}
                  title={autoFollow ? 'Auto-seguimiento activado' : 'Auto-seguimiento desactivado'}
                  aria-label="Auto-seguimiento"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2 L19 21 L12 17 L5 21 Z" />
                  </svg>
                </button>
              </div>
            )}
          </div>

          {/* Sin vehículo registrado no hay flota/alertas/geocercas que
              mostrar en el HUD — solo el mapa base. */}
          {deviceId && (
            <footer id="op-info-bar">
              <div className="op-info-item">
                <span className="op-info-label">Velocidad</span>
                <span className="op-info-value">
                  {Math.round((myDisplay?.speed ?? 0) * 3.6)} km/h
                </span>
              </div>
              <div className="op-info-item">
                <span className="op-info-label">Latitud</span>
                <span className="op-info-value">{myDisplay?.latitude?.toFixed(5) ?? '--'}</span>
              </div>
              <div className="op-info-item">
                <span className="op-info-label">Longitud</span>
                <span className="op-info-value">{myDisplay?.longitude?.toFixed(5) ?? '--'}</span>
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
              <div className="op-info-item">
                <span className="op-info-label">Estado</span>
                <span
                  className={`op-info-value ${myOnline ? 'op-info-value--online' : 'op-info-value--offline'}`}
                >
                  <ConnectionStatusDot connected={myOnline} />
                  {myOnline ? 'En línea' : 'Offline'}
                </span>
              </div>
            </footer>
          )}
        </>
      )}

      {/* 'info' (zona de estacionamiento) no usa el borde pulsante de
          pantalla completa — ese lenguaje visual se reserva para
          warning/danger. El banner de mensaje sí aplica a las 3. */}
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
    </div>
  );
}
