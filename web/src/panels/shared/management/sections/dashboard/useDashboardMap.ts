import {
  createVehicleMarkerElement,
  flyToPoint,
  setVehicleMarkerAccuracy,
  setVehicleMarkerSelected,
  setVehicleMarkerStale,
  updateVehicleMarkerHeading,
  useMapLibreMap,
  useMapMode,
} from '@gaga-gps/map-core';
import type { Position } from '@gaga-gps/shared-types';
import maplibregl from 'maplibre-gl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useActiveOperatorSession } from '../../../hooks/useActiveOperatorSession';
import { adminApi } from '../../api';
import type { DeviceRow } from '../../types';
const OFFLINE_THRESHOLD_MS = 45000;

export interface UseDashboardMapOptions {
  scopedDevices: DeviceRow[];
  historyMode: boolean;
  hasMaps: boolean;
}

export function useDashboardMap({ scopedDevices, historyMode, hasMaps }: UseDashboardMapOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { map, loaded } = useMapLibreMap(containerRef, { center: [-103.7247, 19.2433], zoom: 12 });
  const [mapMode, setMapMode] = useMapMode('gaga_admin_dash_map_mode', 'streets');
  const vehicleMarkersRef = useRef<Record<string, maplibregl.Marker>>({});
  const accuracyRef = useRef<Record<string, number | undefined>>({}); // Módulo círculo de precisión del vehículo (No modificar)
  const selectVehicleRef = useRef<(deviceId: string) => void>(() => {});
  const [livePositions, setLivePositions] = useState<Record<string, Position>>({});
  const [selectedVehicle, setSelectedVehicle] = useState<string | null>(null);

  // fetch inicial una sola vez (no por scope - la respuesta trae la flota completa visible para
  // este usuario, el filtro por proyecto ya lo hace scopedLivePositions más abajo contra
  // scopedDevices) - de ahí en adelante las actualizaciones llegan en vivo por socket
  // (applyFleetUpdate, cableado por DashboardSection.tsx al mismo socket que ya usa para
  // maps:active_update) en vez de seguir haciendo poll. Bug real reportado: con el poll de 7s la
  // "última actualización" del detalle de vehículo se sentía cada ~8s, mientras Supervisor (que
  // ya usa socket) se actualiza cada 1s real.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/fleet/state')
      .then((res) => res.json())
      .then((data: { positions: Position[] }) => {
        if (cancelled) return;
        setLivePositions(Object.fromEntries(data.positions.map((p) => [p.deviceId, p])));
      })
      .catch(() => {
        // Silencioso - es solo un realce visual del mapa.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyFleetUpdate = useCallback((positions: Position[]) => {
    setLivePositions((prev) => {
      const next = { ...prev };
      positions.forEach((p) => {
        next[p.deviceId] = p;
      });
      return next;
    });
  }, []);

  const scopedLivePositions = useMemo(() => {
    const ids = new Set(scopedDevices.map((d) => d.unique_id));
    return Object.values(livePositions).filter((p) => ids.has(p.deviceId));
  }, [livePositions, scopedDevices]);

  const detail = selectedVehicle ? (livePositions[selectedVehicle] ?? null) : null;
  const detailOffline = detail
    ? Date.now() - new Date(detail.fixTime).getTime() > OFFLINE_THRESHOLD_MS
    : false;
  const activeSession = useActiveOperatorSession(selectedVehicle);

  const [latestAppVersionCode, setLatestAppVersionCode] = useState<number | null>(null);
  useEffect(() => {
    adminApi
      .get<{ versionCode: number | null }>('/api/app/version-info')
      .then((r) => setLatestAppVersionCode(r.versionCode))
      .catch(() => {});
  }, []);

  const detailDevice = detail ? scopedDevices.find((d) => d.unique_id === detail.deviceId) : undefined;
  const detailAppVersion = detailDevice
    ? {
        installedVersionCode: (detailDevice.attributes?.installedAppVersionCode as number | undefined) ?? null,
        installedVersionName: (detailDevice.attributes?.installedAppVersionName as string | undefined) ?? null,
        latestVersionCode: latestAppVersionCode,
      }
    : undefined;

  useEffect(() => {
    if (!hasMaps && mapMode !== 'streets') setMapMode('streets');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMaps]);

  useEffect(() => {
    if (!map || !loaded) return;
    if (historyMode) {
      Object.keys(vehicleMarkersRef.current).forEach((id) => {
        vehicleMarkersRef.current[id].remove();
        delete vehicleMarkersRef.current[id];
      });
      return;
    }
    const currentIds = new Set(scopedLivePositions.map((p) => p.deviceId));
    Object.keys(vehicleMarkersRef.current).forEach((id) => {
      if (!currentIds.has(id)) {
        vehicleMarkersRef.current[id].remove();
        delete vehicleMarkersRef.current[id];
        delete accuracyRef.current[id]; // Módulo círculo de precisión del vehículo (No modificar)
      }
    });
    scopedLivePositions.forEach((pos) => {
      const lngLat: [number, number] = [pos.longitude, pos.latitude];
      accuracyRef.current[pos.deviceId] = pos.accuracy; // Módulo círculo de precisión del vehículo (No modificar)
      const existing = vehicleMarkersRef.current[pos.deviceId];
      if (existing) {
        existing.setLngLat(lngLat);
        updateVehicleMarkerHeading(existing.getElement(), pos.deviceId, pos.course, pos.speed);
        setVehicleMarkerStale(
          existing.getElement(),
          Date.now() - new Date(pos.fixTime).getTime() > OFFLINE_THRESHOLD_MS,
        );
        // Módulo círculo de precisión del vehículo (No modificar)
        setVehicleMarkerAccuracy(existing.getElement(), map, pos.latitude, pos.longitude, pos.accuracy);
        return;
      }
      const el = createVehicleMarkerElement({ deviceId: pos.deviceId, isMine: false, color: 'var(--ad-accent)' });
      updateVehicleMarkerHeading(el, pos.deviceId, pos.course, pos.speed);
      setVehicleMarkerStale(el, Date.now() - new Date(pos.fixTime).getTime() > OFFLINE_THRESHOLD_MS);
      setVehicleMarkerAccuracy(el, map, pos.latitude, pos.longitude, pos.accuracy); // Módulo círculo de precisión del vehículo (No modificar)
      el.onclick = () => selectVehicleRef.current(pos.deviceId);
      vehicleMarkersRef.current[pos.deviceId] = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
    });
  }, [map, loaded, scopedLivePositions, historyMode]);

  // Módulo círculo de precisión del vehículo (No modificar)
  // el círculo es en pixeles de pantalla real (no metros) - al hacer zoom hay que recalcular
  // el tamaño de todos aunque no haya llegado una posición nueva
  useEffect(() => {
    if (!map) return;
    const handler = () => {
      Object.entries(vehicleMarkersRef.current).forEach(([deviceId, marker]) => {
        const lngLat = marker.getLngLat();
        setVehicleMarkerAccuracy(marker.getElement(), map, lngLat.lat, lngLat.lng, accuracyRef.current[deviceId]);
      });
    };
    map.on('zoom', handler);
    return () => {
      map.off('zoom', handler);
    };
  }, [map]);

  useEffect(() => {
    Object.entries(vehicleMarkersRef.current).forEach(([deviceId, marker]) => {
      setVehicleMarkerSelected(marker.getElement(), deviceId === selectedVehicle);
    });
  }, [selectedVehicle, scopedLivePositions]);

  function selectVehicle(deviceId: string) {
    setSelectedVehicle(deviceId);
    const pos = livePositions[deviceId];
    if (pos && map) flyToPoint(map, pos.latitude, pos.longitude, { zoom: 18 });
  }
  selectVehicleRef.current = selectVehicle;

  return {
    containerRef,
    map,
    loaded,
    mapMode,
    setMapMode,
    livePositions,
    applyFleetUpdate,
    scopedLivePositions,
    selectedVehicle,
    setSelectedVehicle,
    selectVehicle,
    detail,
    detailOffline,
    detailAppVersion,
    activeSession,
  };
}

export type DashboardMap = ReturnType<typeof useDashboardMap>;
