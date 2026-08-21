import {
  createVehicleMarkerElement,
  setVehicleMarkerSelected,
  setVehicleMarkerStale,
  updateVehicleMarkerHeading,
  useEquipmentLayer,
  useGeofenceLayer,
  useIncidentLayer,
  useMapLibreMap,
  useSatelliteLayers,
  useVehicleAccuracyLayer,
} from '@gaga-gps/map-core';
import { colors } from '@gaga-gps/ui';
import type { EquipmentMarkerData, IncidentMarkerData, MapMode } from '@gaga-gps/map-core';
import type { ActiveMap, Geofence } from '@gaga-gps/shared-types';
import maplibregl from 'maplibre-gl';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { FleetVehicle } from './useSupervisorSocket';

const OFFLINE_THRESHOLD_MS = 45000;
const OFFLINE_CHECK_INTERVAL_MS = 5000;

export interface MapViewHandle {
  flyTo(lat: number, lon: number): void;
}

export interface MapViewProps {
  fleet: Record<string, FleetVehicle>;
  geofences: Geofence[];
  incidents?: IncidentMarkerData[];
  equipment?: EquipmentMarkerData[];
  activeMaps: ActiveMap[];
  mapMode: MapMode;
  selectedVehicleId?: string | null;
  onVehicleClick: (deviceId: string) => void;
  onMapReady?: (map: maplibregl.Map) => void;
}

export const MapView = forwardRef<MapViewHandle, MapViewProps>(function MapView(
  {
    fleet,
    geofences,
    incidents = [],
    equipment = [],
    activeMaps,
    mapMode,
    selectedVehicleId = null,
    onVehicleClick,
    onMapReady,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { map, loaded } = useMapLibreMap(containerRef, { center: [-103.7166, 19.2539], zoom: 16 });
  const markersRef = useRef<Record<string, maplibregl.Marker>>({});
  const onVehicleClickRef = useRef(onVehicleClick);
  onVehicleClickRef.current = onVehicleClick;
  const onMapReadyRef = useRef(onMapReady);
  onMapReadyRef.current = onMapReady;
  const mapReadyFiredRef = useRef(false);

  useSatelliteLayers(map, loaded, activeMaps, mapMode, 'geofences-fill', true);
  useVehicleAccuracyLayer(
    map,
    loaded,
    Object.values(fleet).map((v) => ({
      deviceId: v.deviceId,
      latitude: v.latitude,
      longitude: v.longitude,
      accuracyMeters: v.accuracy,
    })),
  );
  useGeofenceLayer(map, loaded, geofences);
  useIncidentLayer(map, loaded, incidents);
  useEquipmentLayer(map, loaded, equipment);

  useEffect(() => {
    if (!map || !loaded || mapReadyFiredRef.current) return;
    mapReadyFiredRef.current = true;
    onMapReadyRef.current?.(map);
  }, [map, loaded]);

  useImperativeHandle(
    ref,
    () => ({
      flyTo(lat: number, lon: number) {
        map?.flyTo({ center: [lon, lat], zoom: 18, duration: 800 });
      },
    }),
    [map],
  );

  useEffect(() => {
    if (!map || !loaded) return;

    const linkedDeviceIds = new Set(
      equipment.filter((eq) => eq.linkedDeviceId).map((eq) => eq.linkedDeviceId as string),
    );

    const currentIds = new Set(
      Object.values(fleet)
        .filter((v) => !linkedDeviceIds.has(v.deviceId))
        .map((v) => `v-${v.deviceId}`),
    );
    Object.keys(markersRef.current).forEach((id) => {
      if (!currentIds.has(id)) {
        markersRef.current[id].remove();
        delete markersRef.current[id];
      }
    });

    Object.values(fleet).forEach((v) => {
      const id = `v-${v.deviceId}`;

      if (linkedDeviceIds.has(v.deviceId)) {
        if (markersRef.current[id]) {
          markersRef.current[id].remove();
          delete markersRef.current[id];
        }
        return;
      }

      const lngLat: [number, number] = [v.longitude, v.latitude];

      const existing = markersRef.current[id];
      if (existing) {
        existing.setLngLat(lngLat);
        updateVehicleMarkerHeading(existing.getElement(), v.deviceId, v.course, v.speed);
        setVehicleMarkerStale(existing.getElement(), Date.now() - v.lastSeen > OFFLINE_THRESHOLD_MS);
        return;
      }

      const el = createVehicleMarkerElement({ deviceId: v.deviceId, isMine: false, color: colors.accent });
      el.onclick = () => onVehicleClickRef.current(v.deviceId);
      updateVehicleMarkerHeading(el, v.deviceId, v.course, v.speed);
      setVehicleMarkerStale(el, Date.now() - v.lastSeen > OFFLINE_THRESHOLD_MS);

      markersRef.current[id] = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
    });
  }, [map, loaded, fleet, equipment]);

  useEffect(() => {
    Object.entries(markersRef.current).forEach(([id, marker]) => {
      const deviceId = id.replace(/^v-/, '');
      setVehicleMarkerSelected(marker.getElement(), deviceId === selectedVehicleId);
    });
  }, [selectedVehicleId, fleet]);

  useEffect(() => {
    const interval = setInterval(() => {
      Object.entries(markersRef.current).forEach(([id, marker]) => {
        const v = fleet[id.replace(/^v-/, '')];
        if (!v) return;
        setVehicleMarkerStale(marker.getElement(), Date.now() - v.lastSeen > OFFLINE_THRESHOLD_MS);
      });
    }, OFFLINE_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fleet]);

  return <div id="sup-map" ref={containerRef} />;
});
