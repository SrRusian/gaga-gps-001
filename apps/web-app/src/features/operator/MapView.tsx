import { useGeofenceLayer, useMapLibreMap, useSatelliteLayers } from '@gaga-gps/map-core';
import type { MapMode } from '@gaga-gps/map-core';
import { colors } from '@gaga-gps/ui';
import type { ActiveMap, Geofence, Position } from '@gaga-gps/shared-types';
import maplibregl from 'maplibre-gl';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface MapViewHandle {
  flyTo(lat: number, lon: number): void;
}

export interface MapViewProps {
  fleet: Record<string, Position>;
  geofences: Geofence[];
  activeMaps: ActiveMap[];
  mapMode: MapMode;
  myDeviceId: string | null;
}

export const MapView = forwardRef<MapViewHandle, MapViewProps>(function MapView(
  { fleet, geofences, activeMaps, mapMode, myDeviceId },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { map, loaded } = useMapLibreMap(containerRef, {
    center: [-103.56464, 19.35339],
    zoom: 16,
  });
  const markersRef = useRef<Record<string, maplibregl.Marker>>({});

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

  useEffect(() => {
    if (!map || !loaded) return;

    Object.values(fleet).forEach((pos) => {
      const isMine = pos.deviceId === myDeviceId;
      const vehicleId = `vehicle-${pos.deviceId}`;
      const lngLat: [number, number] = [pos.longitude, pos.latitude];

      if (markersRef.current[vehicleId]) {
        markersRef.current[vehicleId].setLngLat(lngLat);
        return;
      }

      const color = isMine ? colors.myVehicle : colors.otherVehicle;
      const el = document.createElement('div');
      el.className = 'op-vehicle-marker';
      el.style.width = '40px';
      el.style.height = '40px';
      el.style.border = `3px solid ${color}`;
      el.style.background = isMine ? '#003322' : '#330a00';
      el.style.color = color;
      el.style.fontSize = '10px';
      el.style.boxShadow = `0 0 8px ${color}`;
      el.textContent = isMine ? 'YO' : `V${pos.deviceId}`;

      markersRef.current[vehicleId] = new maplibregl.Marker({ element: el })
        .setLngLat(lngLat)
        .setPopup(
          new maplibregl.Popup({ offset: 25 }).setHTML(
            `<b>${pos.deviceName || `Vehículo ${pos.deviceId}`}${pos.deviceType ? ` <small>(${pos.deviceType})</small>` : ''}</b><br>
             Lat: ${pos.latitude.toFixed(6)}<br>
             Lon: ${pos.longitude.toFixed(6)}<br>
             Speed: ${((pos.speed ?? 0) * 3.6).toFixed(1)} km/h`,
          ),
        )
        .addTo(map);
    });
  }, [map, loaded, fleet, myDeviceId]);

  return <div id="op-map" ref={containerRef} />;
});
