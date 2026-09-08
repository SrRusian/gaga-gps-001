import {
  createVehicleMarkerElement,
  setVehicleMarkerAccuracy,
  setVehicleMarkerSelected,
  setVehicleMarkerStale,
  updateVehicleMarkerHeading,
  useMapLibreMap,
  useMapMode,
} from '@gaga-gps/map-core';
import type { Position } from '@gaga-gps/shared-types';
import maplibregl from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useActiveOperatorSession } from '../../../hooks/useActiveOperatorSession';
import type { DeviceRow } from '../../types';
import type { Scope } from './scope';

const OFFLINE_THRESHOLD_MS = 45000;

export interface UseDashboardMapOptions {
  scope: Scope;
  scopedDevices: DeviceRow[];
  historyMode: boolean;
  hasMaps: boolean;
}

export function useDashboardMap({ scope, scopedDevices, historyMode, hasMaps }: UseDashboardMapOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { map, loaded } = useMapLibreMap(containerRef, { center: [-103.7247, 19.2433], zoom: 12 });
  const [mapMode, setMapMode] = useMapMode('gaga_admin_dash_map_mode', 'streets');
  const vehicleMarkersRef = useRef<Record<string, maplibregl.Marker>>({});
  const accuracyRef = useRef<Record<string, number | undefined>>({}); // Módulo círculo de precisión del vehículo (No modificar)
  const selectVehicleRef = useRef<(deviceId: string) => void>(() => {});
  const [livePositions, setLivePositions] = useState<Record<string, Position>>({});
  const [selectedVehicle, setSelectedVehicle] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch('/api/fleet/state');
        const data = (await res.json()) as { positions: Position[] };
        if (cancelled) return;
        setLivePositions(Object.fromEntries(data.positions.map((p) => [p.deviceId, p])));
      } catch {
        // Silencioso - es solo un realce visual del mapa.
      }
    }
    poll();
    const interval = setInterval(poll, 7000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [scope]);

  const scopedLivePositions = useMemo(() => {
    const ids = new Set(scopedDevices.map((d) => d.unique_id));
    return Object.values(livePositions).filter((p) => ids.has(p.deviceId));
  }, [livePositions, scopedDevices]);

  const detail = selectedVehicle ? (livePositions[selectedVehicle] ?? null) : null;
  const detailOffline = detail
    ? Date.now() - new Date(detail.fixTime).getTime() > OFFLINE_THRESHOLD_MS
    : false;
  const activeSession = useActiveOperatorSession(selectedVehicle);

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
    if (pos && map) map.flyTo({ center: [pos.longitude, pos.latitude], zoom: 18, duration: 800 });
  }
  selectVehicleRef.current = selectVehicle;

  return {
    containerRef,
    map,
    loaded,
    mapMode,
    setMapMode,
    livePositions,
    scopedLivePositions,
    selectedVehicle,
    setSelectedVehicle,
    selectVehicle,
    detail,
    detailOffline,
    activeSession,
  };
}

export type DashboardMap = ReturnType<typeof useDashboardMap>;
