import { clearSession, getStoredUser } from '@gaga-gps/client';
import { useMapMode } from '@gaga-gps/map-core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MapViewHandle } from './MapView';
import { useActiveOperatorSession } from '../hooks/useActiveOperatorSession';
import { useSupervisorSocket } from './useSupervisorSocket';

const OFFLINE_THRESHOLD_MS = 45000;

// Wiring compartido entre panels/supervisor/index.tsx y panels/project-manager/index.tsx - el
// unico dueño del socket/mapa/seleccion. Lo que cada index.tsx SI decide por su cuenta (boton de
// parada preventiva, permiso de resolver incidentes) no vive aqui a proposito - eso es lo que
// hace a cada pantalla distinta, ver StopControlPanel/AlertsPanel.
export function useSupervisorScreen(storageKey: string) {
  const navigate = useNavigate();
  const user = getStoredUser()!;
  const socket = useSupervisorSocket();
  const [mapMode, setMapMode] = useMapMode(storageKey);
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

  const hasMaps = socket.activeMaps.length > 0;
  const vehicles = useMemo(() => Object.values(socket.fleet), [socket.fleet]);
  const offlineCount = vehicles.filter(
    (v) => now.getTime() - v.lastSeen > OFFLINE_THRESHOLD_MS,
  ).length;
  const onlineCount = vehicles.length - offlineCount;

  function selectVehicle(deviceId: string) {
    setSelectedVehicle(deviceId);
    const v = socket.fleet[deviceId];
    if (v) mapRef.current?.flyTo(v.latitude, v.longitude);
  }

  function closeVehicleDetail() {
    setSelectedVehicle(null);
  }

  const detail = selectedVehicle ? socket.fleet[selectedVehicle] : null;
  const detailOffline = detail ? now.getTime() - detail.lastSeen > OFFLINE_THRESHOLD_MS : false;
  const activeSession = useActiveOperatorSession(selectedVehicle);

  return {
    user,
    ...socket,
    mapMode,
    setMapMode,
    mapRef,
    now,
    hasMaps,
    vehicles,
    onlineCount,
    offlineCount,
    selectedVehicle,
    selectVehicle,
    closeVehicleDetail,
    detail,
    detailOffline,
    activeSession,
    logout,
  };
}
