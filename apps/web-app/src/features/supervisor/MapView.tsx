import { useGeofenceLayer, useMapLibreMap, useSatelliteLayers } from '@gaga-gps/map-core';
import type { MapMode } from '@gaga-gps/map-core';
import type { ActiveMap, Geofence } from '@gaga-gps/shared-types';
import maplibregl from 'maplibre-gl';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { FleetVehicle } from './useSupervisorSocket';

export interface MapViewHandle {
  flyTo(lat: number, lon: number): void;
}

export interface MapViewProps {
  fleet: Record<string, FleetVehicle>;
  geofences: Geofence[];
  activeMaps: ActiveMap[];
  mapMode: MapMode;
  onVehicleClick: (deviceId: string) => void;
}

export const MapView = forwardRef<MapViewHandle, MapViewProps>(function MapView(
  { fleet, geofences, activeMaps, mapMode, onVehicleClick },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { map, loaded } = useMapLibreMap(containerRef, { center: [-103.7166, 19.2539], zoom: 16 });
  const markersRef = useRef<Record<string, maplibregl.Marker>>({});
  const onVehicleClickRef = useRef(onVehicleClick);
  onVehicleClickRef.current = onVehicleClick;

  useSatelliteLayers(map, loaded, activeMaps, mapMode);
  useGeofenceLayer(map, loaded, geofences);

  useImperativeHandle(
    ref,
    () => ({
      flyTo(lat: number, lon: number) {
        map?.flyTo({ center: [lon, lat], zoom: 18, duration: 800 });
      },
    }),
    [map],
  );

  // Marcadores de vehículo — imperativos (maplibregl.Marker no es JSX).
  useEffect(() => {
    if (!map || !loaded) return;

    Object.values(fleet).forEach((v) => {
      const id = `v-${v.deviceId}`;
      const lngLat: [number, number] = [v.longitude, v.latitude];

      const existing = markersRef.current[id];
      if (existing) {
        existing.setLngLat(lngLat);
        return;
      }

      const el = document.createElement('div');
      el.className = 'sup-vehicle-marker';
      el.textContent = `V${v.deviceId}`;
      el.onclick = () => onVehicleClickRef.current(v.deviceId);

      markersRef.current[id] = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
    });
  }, [map, loaded, fleet]);

  return <div id="sup-map" ref={containerRef} />;
});
