import {
  createVehicleMarkerElement,
  setVehicleMarkerSelected,
  setVehicleMarkerStale,
  setVehicleMarkerThreat,
  updateVehicleMarkerHeading,
  useEquipmentLayer,
  useGeofenceLayer,
  useIncidentLayer,
  useMapLibreMap,
  useSatelliteLayers,
  useVehicleAccuracyLayer,
} from '@gaga-gps/map-core';
import type { EquipmentMarkerData, IncidentMarkerData, MapMode } from '@gaga-gps/map-core';
import { colors } from '@gaga-gps/ui';
import type { ActiveMap, Geofence, Position } from '@gaga-gps/shared-types';
import maplibregl from 'maplibre-gl';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

const STALE_THRESHOLD_MS = 10000;
const STALE_CHECK_INTERVAL_MS = 2000;
const GLIDE_MAX_MS = 1000;
const GLIDE_MIN_MS = 200;
const GLIDE_FALLBACK_MS = 800;

export interface MapViewHandle {
  flyTo(lat: number, lon: number): void;
  follow(lat: number, lon: number): void;
  frameThreat(my: [number, number], other: [number, number]): void;
}

export interface MapViewProps {
  fleet: Record<string, Position>;
  geofences: Geofence[];
  incidents?: IncidentMarkerData[];
  equipment?: EquipmentMarkerData[];
  activeMaps: ActiveMap[];
  mapMode: MapMode;
  myDeviceId: string | null;
  threatDeviceId?: string | null;
  highlightedGeofenceId?: number | null;
  selectedVehicleId?: string | null;
  onVehicleClick?: (deviceId: string) => void;
  onUserInteraction?: () => void;
}

export const MapView = forwardRef<MapViewHandle, MapViewProps>(function MapView(
  {
    fleet,
    geofences,
    incidents = [],
    equipment = [],
    activeMaps,
    mapMode,
    myDeviceId,
    threatDeviceId,
    highlightedGeofenceId,
    selectedVehicleId = null,
    onVehicleClick,
    onUserInteraction,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { map, loaded } = useMapLibreMap(containerRef, {
    center: [-103.56464, 19.35339],
    zoom: 16,
  });
  const markersRef = useRef<Record<string, maplibregl.Marker>>({});
  const lastFixTimeRef = useRef<Record<string, number>>({});
  const glideFrameRef = useRef<Record<string, number>>({});
  const onVehicleClickRef = useRef(onVehicleClick);
  onVehicleClickRef.current = onVehicleClick;

  function glideMarkerTo(
    marker: maplibregl.Marker,
    vehicleId: string,
    to: [number, number],
    sinceLastFixMs: number | undefined,
  ) {
    const from = marker.getLngLat();
    const fromLngLat: [number, number] = [from.lng, from.lat];
    if (fromLngLat[0] === to[0] && fromLngLat[1] === to[1]) return;

    const existingFrame = glideFrameRef.current[vehicleId];
    if (existingFrame) cancelAnimationFrame(existingFrame);

    const duration = sinceLastFixMs
      ? Math.min(Math.max(sinceLastFixMs, GLIDE_MIN_MS), GLIDE_MAX_MS)
      : GLIDE_FALLBACK_MS;
    const start = performance.now();

    function step(now: number) {
      const t = Math.min((now - start) / duration, 1);
      marker.setLngLat([
        fromLngLat[0] + (to[0] - fromLngLat[0]) * t,
        fromLngLat[1] + (to[1] - fromLngLat[1]) * t,
      ]);
      if (t < 1) {
        glideFrameRef.current[vehicleId] = requestAnimationFrame(step);
      } else {
        delete glideFrameRef.current[vehicleId];
      }
    }
    glideFrameRef.current[vehicleId] = requestAnimationFrame(step);
  }

  useEffect(() => {
    const frames = glideFrameRef.current;
    return () => {
      Object.values(frames).forEach((frame) => cancelAnimationFrame(frame));
    };
  }, []);

  useSatelliteLayers(map, loaded, activeMaps, mapMode, 'geofences-fill', true);
  useVehicleAccuracyLayer(
    map,
    loaded,
    Object.values(fleet).map((pos) => ({
      deviceId: pos.deviceId,
      latitude: pos.latitude,
      longitude: pos.longitude,
      accuracyMeters: pos.accuracy,
    })),
  );
  useGeofenceLayer(map, loaded, geofences, highlightedGeofenceId);
  useIncidentLayer(map, loaded, incidents);
  useEquipmentLayer(map, loaded, equipment);

  useImperativeHandle(
    ref,
    () => ({
      flyTo(lat: number, lon: number) {
        map?.flyTo({ center: [lon, lat], zoom: 18, duration: 800 });
      },
      follow(lat: number, lon: number) {
        map?.easeTo({ center: [lon, lat], duration: 600 });
      },
      frameThreat(my: [number, number], other: [number, number]) {
        map?.fitBounds([my, other], { padding: 80, maxZoom: 18, duration: 800 });
      },
    }),
    [map],
  );

  useEffect(() => {
    if (!map || !onUserInteraction) return;

    const handler = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) onUserInteraction();
    };
    map.on('dragstart', handler);
    map.on('zoomstart', handler);

    return () => {
      map.off('dragstart', handler);
      map.off('zoomstart', handler);
    };
  }, [map, onUserInteraction]);

  useEffect(() => {
    if (!map || !loaded) return;

    const linkedDeviceIds = new Set(
      equipment.filter((eq) => eq.linkedDeviceId).map((eq) => eq.linkedDeviceId as string),
    );

    const currentIds = new Set(
      Object.values(fleet)
        .filter((pos) => !linkedDeviceIds.has(pos.deviceId))
        .map((pos) => `vehicle-${pos.deviceId}`),
    );
    Object.keys(markersRef.current).forEach((vehicleId) => {
      if (!currentIds.has(vehicleId)) {
        markersRef.current[vehicleId].remove();
        delete markersRef.current[vehicleId];
        delete lastFixTimeRef.current[vehicleId];
        const frame = glideFrameRef.current[vehicleId];
        if (frame) cancelAnimationFrame(frame);
        delete glideFrameRef.current[vehicleId];
      }
    });

    Object.values(fleet).forEach((pos) => {
      const vehicleId = `vehicle-${pos.deviceId}`;

      if (linkedDeviceIds.has(pos.deviceId)) {
        if (markersRef.current[vehicleId]) {
          markersRef.current[vehicleId].remove();
          delete markersRef.current[vehicleId];
        }
        return;
      }

      const isMine = pos.deviceId === myDeviceId;
      const lngLat: [number, number] = [pos.longitude, pos.latitude];
      const now = Date.now();
      const previousFixAt = lastFixTimeRef.current[vehicleId];
      lastFixTimeRef.current[vehicleId] = now;

      if (markersRef.current[vehicleId]) {
        const marker = markersRef.current[vehicleId];
        glideMarkerTo(
          marker,
          vehicleId,
          lngLat,
          previousFixAt ? now - previousFixAt : undefined,
        );
        updateVehicleMarkerHeading(marker.getElement(), pos.deviceId, pos.course, pos.speed);
        setVehicleMarkerStale(marker.getElement(), false);
        return;
      }

      const color = isMine ? colors.myVehicle : colors.otherVehicle;
      const el = createVehicleMarkerElement({ deviceId: pos.deviceId, isMine, color });
      updateVehicleMarkerHeading(el, pos.deviceId, pos.course, pos.speed);
      el.onclick = () => onVehicleClickRef.current?.(pos.deviceId);

      markersRef.current[vehicleId] = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
    });
  }, [map, loaded, fleet, myDeviceId, equipment]);

  useEffect(() => {
    Object.entries(markersRef.current).forEach(([vehicleId, marker]) => {
      const deviceId = vehicleId.replace(/^vehicle-/, '');
      setVehicleMarkerThreat(marker.getElement(), deviceId === threatDeviceId);
      setVehicleMarkerSelected(marker.getElement(), deviceId === selectedVehicleId);
    });
  }, [threatDeviceId, selectedVehicleId, fleet]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      Object.entries(markersRef.current).forEach(([vehicleId, marker]) => {
        const lastFix = lastFixTimeRef.current[vehicleId];
        const isStale = !lastFix || now - lastFix > STALE_THRESHOLD_MS;
        setVehicleMarkerStale(marker.getElement(), isStale);
      });
    }, STALE_CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  return <div id="op-map" ref={containerRef} />;
});
