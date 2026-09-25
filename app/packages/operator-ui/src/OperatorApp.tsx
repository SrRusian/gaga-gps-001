import { RtkNtrip } from '@gaga-gps/android-bridge';
import { clearSession, getStoredUser } from '@gaga-gps/client';
import { haversineMeters, useMapMode } from '@gaga-gps/map-core';
import type { Position } from '@gaga-gps/shared-types';
import { MapModeSelector } from '@gaga-gps/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './operator.css';
import { sortAlertStack, topSoundAlert, type StackedAlert } from './alertPriority';
import { MapView, type MapViewHandle } from './MapView';
import { OperatorLoginOverlay } from './OperatorLoginOverlay';
import { ReportIncidentOverlay } from './ReportIncidentOverlay';
import { useAlertSound } from './useAlertSound';
import { useBatteryLevel } from './useBatteryLevel';
import { useClock } from './useClock';
import { useDeviceGeolocation } from './useDeviceGeolocation';
import { useDeviceSensorReporter } from './useDeviceSensorReporter';
import { useDeviceId } from './useDeviceId';
import { useIncidentReporter } from './useIncidentReporter';
import { useOperatorAuth } from './useOperatorAuth';
import { useOperatorSocket } from './useOperatorSocket';
import { useLocalAlerts, type GeofenceToast } from './useLocalAlerts';
import { useNetworkOnline, useNetworkType, type NetworkType } from './useNetworkStatus';
import { stationaryThresholdKmh } from './localSpeed';
import { useVehicleFootprints } from './useVehicleFootprints';

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

function networkTypeLabel(type: NetworkType): string {
  switch (type) {
    case 'wifi':
      return 'WiFi';
    case 'cellular':
      return 'Datos móviles';
    case 'ethernet':
      return 'Ethernet';
    case 'none':
      return 'Sin conexión';
    default:
      return 'Red';
  }
}

// iconos de linea, mismo estilo que los FAB del mapa (viewBox 24, stroke=currentColor) - solo
// distinguen de que trata cada chip, el color/estado lo sigue llevando el punto de color
function GpsIcon() {
  return (
    <svg className="op-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 22s-7-7.58-7-12.5A7 7 0 0 1 19 9.5C19 14.42 12 22 12 22Z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </svg>
  );
}

function WifiIcon() {
  return (
    <svg className="op-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M2 8.5a16 16 0 0 1 20 0" />
      <path d="M5 12a11 11 0 0 1 14 0" />
      <path d="M8.5 15.5a6 6 0 0 1 7 0" />
      <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CellularIcon() {
  return (
    <svg className="op-status-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <rect x="2" y="15" width="3.5" height="6" rx="0.5" />
      <rect x="8" y="11" width="3.5" height="10" rx="0.5" />
      <rect x="14" y="6" width="3.5" height="15" rx="0.5" />
      <rect x="20" y="2" width="2" height="19" rx="0.5" opacity="0.35" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg className="op-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

// aviso "Entrando a/Saliendo de zona X" - transitorio, sin sonido, tipo Google Maps. Se mantiene
// SIEMPRE montado (nunca condicional en el arbol) y se controla por clase CSS/transicion en vez de
// mount/unmount - asi la animacion de salida (opacity/transform, ver operator.css) se ve completa
// en vez de desaparecer de golpe cuando useLocalAlerts limpia el toast a null
function GeofenceToastBanner({ toast }: { toast: GeofenceToast | null }) {
  const [lastMessage, setLastMessage] = useState('');
  useEffect(() => {
    if (toast) setLastMessage(toast.message);
  }, [toast]);
  return (
    <div className={`op-geofence-toast${toast ? ' op-geofence-toast--visible' : ''}`}>{lastMessage}</div>
  );
}

export default function OperatorApp() {
  const navigate = useNavigate();
  const user = getStoredUser()!;
  const deviceId = useDeviceId();
  const { session, operatingEquipment, needsShiftStart, shiftStartError, checking, startShift, endShift } =
    useOperatorAuth(deviceId);
  // se resuelve antes del socket a proposito: sin conexion es la UNICA fuente de posicion, y es la
  // que alimenta la evaluacion local de geocercas dentro de useOperatorSocket
  const {
    position: localGeo,
    error: geoError,
    supported: geoSupported,
    gpsSource,
    rtkConnected,
  } = useDeviceGeolocation();
  const {
    connected,
    activeCount,
    geofences,
    equipment,
    activeMaps,
    fleet,
    alert,
    connectivityAlert,
    nearestVehicle,
    nearestOnRoute,
    threat,
    activeGeofenceId,
    incidents,
    proximityNotice,
    networkNotice,
    restrictedToAllowedZone,
    geofencesReady,
  } = useOperatorSocket(deviceId);
  const [mapMode, setMapMode] = useMapMode('gaga_operator_map_mode');
  const [autoFollow, setAutoFollow] = useAutoFollow();
  const [framingThreat, setFramingThreat] = useState(false);
  const [showReportIncident, setShowReportIncident] = useState(false);
  const mapRef = useRef<MapViewHandle>(null);
  const { report: reportIncident, submitting: reportingIncident, error: reportIncidentError } =
    useIncidentReporter(deviceId);

  const { level: batteryLevel, charging: batteryCharging } = useBatteryLevel();
  const networkOnline = useNetworkOnline();
  const networkType = useNetworkType();
  const clockLabel = useClock();
  useDeviceSensorReporter(deviceId);
  const { footprints: vehicleFootprints, limits: speedLimits, category: vehicleCategory } = useVehicleFootprints(deviceId);

  // El congelado de posicion con el vehiculo detenido depende del TIPO de vehiculo, no de una
  // constante global: una excavadora trabaja por debajo del umbral y congelarla escondería trabajo
  // real. Se empuja al lado nativo en cuanto se conocen los limites (llegan cacheados al instante
  // si ya se abrio antes, o al primer fetch de /api/devices).
  useEffect(() => {
    RtkNtrip.setStationaryThreshold({ speedKmh: stationaryThresholdKmh(vehicleCategory) }).catch(() => {});
  }, [vehicleCategory]);

  // instancia unica compartida por TODO el sistema de alertas (antes vivia dentro de
  // useOperatorSocket y se pasaba hacia abajo a useLocalAlerts) - ahora que el sonido se decide de
  // forma centralizada aqui (ver el stack mas abajo), tiene que haber una sola instancia real
  const { playWarningSound, playDangerSound, stopSound } = useAlertSound();

  // la tableta decide geocercas y velocidad por su cuenta, con o sin conexion, y le reporta al
  // servidor lo que decide (ver useLocalAlerts.ts) - puede haber varias condiciones activas a la
  // vez (zona restringida + geocerca + velocidad), a diferencia de antes que solo devolvia una
  const { alerts: localAlerts, toast: geofenceToast } = useLocalAlerts(
    deviceId,
    geofences,
    localGeo
      ? {
          latitude: localGeo.latitude,
          longitude: localGeo.longitude,
          speedKmh: (localGeo.speed ?? 0) * 3.6,
          headingDeg: localGeo.heading,
          accuracyMeters: localGeo.accuracy,
        }
      : null,
    speedLimits,
    connected,
    restrictedToAllowedZone,
    geofencesReady,
    deviceId ? (vehicleFootprints[deviceId] ?? null) : null,
    vehicleCategory,
  );

  // "alguna vez tuvo RTK conectado en esta sesion" - el aviso de RTK desconectado solo tiene
  // sentido si ALGUNA VEZ hubo receptor (si nunca lo hubo, usar el GPS de la tableta es lo normal,
  // no una degradacion de nada - avisar siempre seria ruido constante para flotas sin RTK)
  const everConnectedRtkRef = useRef(false);
  if (rtkConnected) everConnectedRtkRef.current = true;

  // --- sistema de prioridad de alertas: multiples fuentes pueden estar activas a la vez, se ven
  // todas (sin saturar - la mas urgente arriba, el resto compacto), pero solo UNA suena: la de
  // mayor prioridad. Si esa se resuelve, la siguiente en la fila retoma el sonido sola (ver
  // alertPriority.ts). "server" cubre lo que solo el backend puede decidir (colision, proximidad,
  // equipo, incidentes, parada preventiva); "connectivity" cubre servidor/red desconectados;
  // "rtk" el receptor desconectado; el resto son las 3 condiciones locales de useLocalAlerts.
  const alertStack: StackedAlert[] = [];
  if (alert.severity === 'warning' || alert.severity === 'danger') {
    alertStack.push({ id: 'server', severity: alert.severity, message: alert.message, loop: alert.loop, sound: !alert.silent });
  }
  if (connectivityAlert) {
    alertStack.push({ id: 'connectivity', severity: connectivityAlert.severity, message: connectivityAlert.message, loop: connectivityAlert.loop, sound: true });
  }
  if (everConnectedRtkRef.current && gpsSource === 'tablet') {
    alertStack.push({
      id: 'rtk',
      severity: 'warning',
      message: 'RECEPTOR RTK DESCONECTADO - USANDO GPS INTERNO',
      loop: false,
      sound: true,
    });
  }
  for (const local of localAlerts) {
    alertStack.push({ id: local.source, severity: local.severity, message: local.message, loop: local.severity === 'danger', sound: true });
  }
  const sortedAlerts = sortAlertStack(alertStack);
  const topAlert = sortedAlerts[0] ?? null;
  const topSound = topSoundAlert(sortedAlerts);

  // el contenedor de alertas queda SIEMPRE montado (ver JSX abajo) para poder animar su cierre -
  // mientras se colapsa conserva el ultimo contenido no vacio, si no el texto desaparecia de golpe
  // justo cuando el espacio recien empezaba a encogerse
  const [displayedAlerts, setDisplayedAlerts] = useState<StackedAlert[]>([]);
  useEffect(() => {
    if (sortedAlerts.length > 0) setDisplayedAlerts(sortedAlerts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(sortedAlerts)]);
  const alertStackOpen = sortedAlerts.length > 0;

  // el sonido solo se toca cuando cambia QUIEN suena (id+severidad+loop) - nunca en cada render,
  // o el pitido se reiniciaria constantemente y nunca llegaria a sonar completo
  const soundSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    const signature = topSound ? `${topSound.id}:${topSound.severity}:${topSound.loop}` : null;
    if (signature === soundSignatureRef.current) return;
    soundSignatureRef.current = signature;
    if (!topSound) {
      stopSound();
    } else if (topSound.severity === 'danger') {
      playDangerSound(topSound.loop);
    } else {
      playWarningSound();
    }
  }, [topSound, playDangerSound, playWarningSound, stopSound]);

  const effectiveGeofenceId =
    localAlerts.find((a) => a.source === 'geofence')?.geofenceId ?? activeGeofenceId;

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

  const myVehicleTypeName = deviceId ? (vehicleFootprints[deviceId]?.vehicleTypeName ?? null) : null;
  const deviceName = myDisplay?.deviceName
    ? `${myDisplay.deviceName}${myVehicleTypeName ? ` (${myVehicleTypeName})` : ''}`
    : (deviceId ?? 'Sin vehículo asignado');

  // 3 estados reales, no 2: RTK (bueno) vs GPS de la tableta (peor precision, sin RTK detras) vs
  // sin ningun fix todavia - antes solo distinguia "hay posicion o no", asi que desconectar el RTK
  // no cambiaba nada en pantalla mientras la tableta siguiera entregando su propio GPS
  const gpsLabel = !geoSupported
    ? 'GPS no disponible'
    : gpsSource === 'rtk'
      ? 'GPS: RTK'
      : gpsSource === 'tablet'
        ? 'GPS: Interno'
        : 'GPS: Sin señal';
  const gpsDotClass = !geoSupported
    ? 'op-status-dot--warning'
    : gpsSource === 'rtk'
      ? 'op-status-dot--ok'
      : gpsSource === 'tablet'
        ? 'op-status-dot--bad'
        : 'op-status-dot--danger';
  const gpsUrgent = geoSupported && gpsSource === null;
  const networkLabel = networkTypeLabel(networkType);

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
          <span
            className={`op-status-chip${
              !networkOnline ? ' op-status-chip--warning' : !connected ? ' op-status-chip--urgent' : ''
            }`}
          >
            <span
              className={`op-status-dot${
                !networkOnline ? ' op-status-dot--warning' : connected ? ' op-status-dot--ok' : ' op-status-dot--danger'
              }`}
            />
            {!networkOnline ? 'Sin Red' : connected ? 'Conectada' : 'Desconectado'}
          </span>
          <span className={`op-status-chip${gpsUrgent ? ' op-status-chip--urgent' : ''}`}>
            <span className={`op-status-dot ${gpsDotClass}`} />
            <GpsIcon />
            {gpsLabel}
            {geoError && <span id="op-gps-error"> ({geoError})</span>}
          </span>
          <span className="op-status-chip">
            <span className={`op-status-dot${networkOnline ? ' op-status-dot--ok' : ' op-status-dot--warning'}`} />
            {networkType === 'cellular' ? <CellularIcon /> : <WifiIcon />}
            {networkLabel}
          </span>
          <span className="op-status-chip op-clock">
            <ClockIcon />
            {clockLabel}
          </span>
        </div>
      </header>

      <div className={`op-alert-stack-wrap${alertStackOpen ? ' op-alert-stack-wrap--open' : ''}`}>
        <div className="op-alert-stack">
          <div className="op-alert-stack-inner">
            {displayedAlerts.map((a, index) => (
              <div
                key={a.id}
                className={`op-alert-message ${a.severity}${index > 0 ? ' op-alert-message--stacked' : ''}`}
              >
                <span className="op-alert-message-dot" />
                {a.message}
              </div>
            ))}
          </div>
        </div>
      </div>

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
              highlightedGeofenceId={effectiveGeofenceId}
              initialCenter={[myDisplay.longitude, myDisplay.latitude]}
              deviceFootprints={vehicleFootprints}
              onUserInteraction={() => setAutoFollow(false)}
            />

            <div className="op-map-mode-selector-wrap">
              <MapModeSelector mode={mapMode} onChange={setMapMode} />
            </div>

            <GeofenceToastBanner toast={geofenceToast} />

            {(proximityNotice || networkNotice) && (
              <div className="op-notice-stack">
                {proximityNotice && (
                  <div className="op-proximity-notice">
                    <span className="op-proximity-notice-dot" />
                    {proximityNotice.message} ({Math.round(proximityNotice.distanceMeters)} m)
                  </div>
                )}
                {networkNotice && (
                  <div className={`op-network-notice op-network-notice--${networkNotice.severity}`}>
                    <span className="op-network-notice-dot" />
                    {networkNotice.message}
                  </div>
                )}
              </div>
            )}

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
                <span className="op-info-label">Vehículo más cercano</span>
                <span className="op-info-value">
                  {liveNearest ? `${Math.round(liveNearest.distanceM)} m` : '--'}
                  {liveNearest?.stale && <span id="op-nearest-stale"> (sin señal)</span>}
                </span>
              </div>
              {nearestOnRoute && (
                <div className="op-info-item">
                  <span className="op-info-label">Más cercano en ruta</span>
                  <span className="op-info-value">{nearestOnRoute.distanceMeters} m</span>
                </div>
              )}
              {batteryLevel !== null && (
                <div className="op-info-item">
                  <span className="op-info-label">Batería</span>
                  <span className="op-info-value">
                    {batteryCharging ? (
                      <span className="op-battery-charging">
                        <span className="op-battery-charging-dot" />
                        Conectada
                      </span>
                    ) : (
                      `${batteryLevel}%`
                    )}
                  </span>
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
      <div id="op-alert-overlay" className={topAlert?.severity ?? ''} />

      {!deviceId && (
        <div className="op-full-overlay active">
          <div className="op-overlay-card">
            <h2>Dispositivo sin configurar</h2>
            <p>
              Esta tableta todavía no tiene un identificador de dispositivo configurado. Cierra
              sesión y entra a Ajustes (engranaje en la pantalla de inicio) para configurarlo en
              "Servidor e identidad" antes de continuar.
            </p>
            <button className="op-btn op-btn--danger" onClick={logout}>
              Cerrar sesión
            </button>
          </div>
        </div>
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
