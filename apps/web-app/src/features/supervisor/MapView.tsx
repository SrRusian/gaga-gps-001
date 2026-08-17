import {
  createHeadingArrow,
  shortVehicleLabel,
  updateVehicleMarkerHeading,
  useEquipmentLayer,
  useGeofenceLayer,
  useIncidentLayer,
  useMapLibreMap,
  useSatelliteLayers,
} from '@gaga-gps/map-core';
import { colors } from '@gaga-gps/ui';
import type { EquipmentMarkerData, IncidentMarkerData, MapMode } from '@gaga-gps/map-core';
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
  incidents?: IncidentMarkerData[];
  /** Equipo estático del proyecto (radio de giro/seguridad) - dispositivos vinculados no se dibujan como vehículo, ver abajo. */
  equipment?: EquipmentMarkerData[];
  activeMaps: ActiveMap[];
  mapMode: MapMode;
  onVehicleClick: (deviceId: string) => void;
  /**
   * Entrega la instancia real de `maplibregl.Map` una sola vez, apenas
   * el mapa termina de cargar - permite que un componente hermano
   * (`GeoManagementPanel`, geocercas/equipo/mapas) monte su propio
   * `MapboxDraw`/manejo de clics contra el mismo mapa sin que este
   * archivo tenga que saber nada de dibujo o de CRUD - sigue siendo
   * puramente un renderizador en vivo.
   */
  onMapReady?: (map: maplibregl.Map) => void;
}

export const MapView = forwardRef<MapViewHandle, MapViewProps>(function MapView(
  { fleet, geofences, incidents = [], equipment = [], activeMaps, mapMode, onVehicleClick, onMapReady },
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

  // Marcadores de vehículo - imperativos (maplibregl.Marker no es JSX).
  useEffect(() => {
    if (!map || !loaded) return;

    // Un dispositivo vinculado a equipo estático ya se representa con
    // los dos anillos de useEquipmentLayer, en su posición registrada
    // - no se dibuja también como "vehículo" encima del mismo punto
    // (mismo criterio ya aplicado en Operador).
    const linkedDeviceIds = new Set(
      equipment.filter((eq) => eq.linkedDeviceId).map((eq) => eq.linkedDeviceId as string),
    );

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
        return;
      }

      const el = document.createElement('div');
      el.className = 'sup-vehicle-marker';
      el.textContent = shortVehicleLabel(v.deviceId);
      el.onclick = () => onVehicleClickRef.current(v.deviceId);
      el.appendChild(createHeadingArrow(colors.accent));
      updateVehicleMarkerHeading(el, v.deviceId, v.course, v.speed);

      markersRef.current[id] = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
    });
  }, [map, loaded, fleet, equipment]);

  return <div id="sup-map" ref={containerRef} />;
});
