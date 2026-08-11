import {
  createVehicleMarkerElement,
  setVehicleMarkerStale,
  setVehicleMarkerThreat,
  updateVehicleMarkerHeading,
  useGeofenceLayer,
  useMapLibreMap,
  useSatelliteLayers,
} from '@gaga-gps/map-core';
import type { MapMode } from '@gaga-gps/map-core';
import { colors } from '@gaga-gps/ui';
import type { ActiveMap, Geofence, Position } from '@gaga-gps/shared-types';
import maplibregl from 'maplibre-gl';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

// Mismo umbral que SignalLostService (backend) / detección local de
// desconexión (useOperatorSocket) — a partir de acá una posición se
// considera "vieja" y se atenúa en el mapa en vez de quedar
// congelada sin ningún indicio visual.
const STALE_THRESHOLD_MS = 10000;
const STALE_CHECK_INTERVAL_MS = 2000;

// "Glide" entre fixes — sin esto el marcador salta de golpe cada vez
// que llega una posición nueva. Se anima en el mismo intervalo que
// tardó en llegar el fix anterior (así el glide termina justo cuando
// se espera el siguiente, ni se adelanta ni se queda corto), acotado
// para no quedar pegado si hubo un hueco largo de datos.
const GLIDE_MAX_MS = 1000;
const GLIDE_MIN_MS = 200;
const GLIDE_FALLBACK_MS = 800;

export interface MapViewHandle {
  /** Centrado manual — botón ⊙, fuerza zoom 18. */
  flyTo(lat: number, lon: number): void;
  /** Seguimiento continuo — no fuerza zoom, para no pelear con un zoom manual del operador. */
  follow(lat: number, lon: number): void;
  /** Encuadra ambos vehículos durante una alerta crítica de proximidad/colisión. */
  frameThreat(my: [number, number], other: [number, number]): void;
}

export interface MapViewProps {
  fleet: Record<string, Position>;
  geofences: Geofence[];
  activeMaps: ActiveMap[];
  mapMode: MapMode;
  myDeviceId: string | null;
  /** Vehículo más cercano fuera de ruta — resalta su marcador cuando está por debajo del umbral de alerta. */
  threatDeviceId?: string | null;
  /** Geocerca de la alerta activa (si aplica) — se resalta con un pulso en el mapa. */
  highlightedGeofenceId?: number | null;
  /** Se dispara cuando el propio operador arrastra/hace zoom manualmente — usado para apagar el auto-seguimiento. */
  onUserInteraction?: () => void;
}

export const MapView = forwardRef<MapViewHandle, MapViewProps>(function MapView(
  {
    fleet,
    geofences,
    activeMaps,
    mapMode,
    myDeviceId,
    threatDeviceId,
    highlightedGeofenceId,
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

  useSatelliteLayers(map, loaded, activeMaps, mapMode);
  useGeofenceLayer(map, loaded, geofences, highlightedGeofenceId);

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

  // El auto-seguimiento se apaga si el operador toca el mapa a mano
  // — `originalEvent` solo existe en gestos de usuario, no en los
  // que dispara programáticamente flyTo/easeTo/fitBounds de arriba.
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

    Object.values(fleet).forEach((pos) => {
      const isMine = pos.deviceId === myDeviceId;
      const vehicleId = `vehicle-${pos.deviceId}`;
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

  // Resalta el marcador del vehículo "amenaza" (más cercano durante
  // una alerta activa de proximidad/colisión) con un halo pulsante.
  useEffect(() => {
    Object.entries(markersRef.current).forEach(([vehicleId, marker]) => {
      const deviceId = vehicleId.replace(/^vehicle-/, '');
      setVehicleMarkerThreat(marker.getElement(), deviceId === threatDeviceId);
    });
  }, [threatDeviceId, fleet]);

  // "Posición vieja" — sin nuevos datos por más del umbral, la
  // congelada de siempre pasa a atenuarse en vez de quedar como si
  // estuviera al día. Corre en un tick propio: sin esto, un
  // dispositivo que dejó de reportar nunca dispararía el efecto de
  // arriba (depende de `fleet`, que ya no cambia para ese vehículo).
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
