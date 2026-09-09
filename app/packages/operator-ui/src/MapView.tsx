import {
  createVehicleMarkerElement,
  flyToBounds,
  flyToPoint,
  realignVehicleMarkerToBearing,
  resolveVehicleCourse,
  setVehicleMarkerAccuracy,
  setVehicleMarkerStale,
  setVehicleMarkerThreat,
  updateVehicleMarkerHeading,
  useEquipmentLayer,
  useGeofenceLayer,
  useIncidentLayer,
  useMapLibreMap,
  useSatelliteLayers,
} from '@gaga-gps/map-core';
import type { EquipmentMarkerData, IncidentMarkerData, MapMode } from '@gaga-gps/map-core';
import { colors } from '@gaga-gps/ui';
import type { ActiveMap, Geofence, Position } from '@gaga-gps/shared-types';
import maplibregl from 'maplibre-gl';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

const STALE_THRESHOLD_MS = 3000;
const STALE_CHECK_INTERVAL_MS = 1000;
const GLIDE_MAX_MS = 1000;
const GLIDE_MIN_MS = 200;
const GLIDE_FALLBACK_MS = 800;

export interface MapViewHandle {
  flyTo(lat: number, lon: number): void;
  follow(lat: number, lon: number, course?: number, speed?: number): void;
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
  initialCenter: [number, number];
  initialZoom?: number;
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
    initialCenter,
    initialZoom = 17,
    onUserInteraction,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { map, loaded } = useMapLibreMap(containerRef, {
    center: initialCenter,
    zoom: initialZoom,
  });
  const markersRef = useRef<Record<string, maplibregl.Marker>>({});
  const lastFixTimeRef = useRef<Record<string, number>>({});
  const fixTimeRef = useRef<Record<string, number>>({});
  const accuracyRef = useRef<Record<string, number | undefined>>({}); // Módulo círculo de precisión del vehículo (No modificar)
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

  useSatelliteLayers(map, loaded, activeMaps, mapMode, true);
  useGeofenceLayer(map, loaded, geofences, highlightedGeofenceId);
  useIncidentLayer(map, loaded, incidents);
  useEquipmentLayer(map, loaded, equipment);

  useImperativeHandle(
    ref,
    () => ({
      flyTo(lat: number, lon: number) {
        flyToPoint(map, lat, lon, { zoom: 18 });
      },
      // "seguir" se llama en cada posicion nueva mientras se conduce (varias veces por minuto) -
      // se queda con un easeTo corto y sin la curva "alejar y acercar" a proposito, esa animacion
      // es para centrados puntuales (un clic, un boton), repetirla en cada tick marearia.
      // Modo "orientado al frente": el mapa gira para que mi rumbo siempre apunte hacia arriba -
      // la flecha de mi propio vehiculo se queda fija (ver realineado de las demas mas abajo,
      // reaccionan al 'rotate' del mapa). Se reusa resolveVehicleCourse (mismo criterio que los
      // marcadores) para no rotar el mapa con un rumbo "fantasma" mientras el vehiculo esta
      // detenido - se queda con el ultimo rumbo real conocido.
      follow(lat: number, lon: number, course, speed) {
        if (!map) return;
        const { course: bearing } = resolveVehicleCourse(myDeviceId ?? '', course, speed);
        map.easeTo({ center: [lon, lat], bearing, duration: 600 });
      },
      // caso urgente (colision inminente) - se mantiene una duracion corta fija en vez de dejar
      // que la velocidad natural decida, para que el encuadre pase de inmediato
      frameThreat(my: [number, number], other: [number, number]) {
        flyToBounds(map, [my, other], { padding: 80, maxZoom: 18, duration: 700 });
      },
    }),
    [map, myDeviceId],
  );

  useEffect(() => {
    if (!map || !onUserInteraction) return;

    const handler = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) onUserInteraction();
    };
    map.on('dragstart', handler);
    map.on('zoomstart', handler);
    map.on('rotatestart', handler);

    return () => {
      map.off('dragstart', handler);
      map.off('zoomstart', handler);
      map.off('rotatestart', handler);
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
        delete fixTimeRef.current[vehicleId];
        delete accuracyRef.current[vehicleId.replace(/^vehicle-/, '')]; // Módulo círculo de precisión del vehículo (No modificar)
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
      accuracyRef.current[pos.deviceId] = pos.accuracy; // Módulo círculo de precisión del vehículo (No modificar)

      // fixTime real del reporte (no "cuándo lo vio este navegador") - así al recargar la
      // página un vehículo ya offline se marca de inmediato, sin esperar un umbral completo
      const fixTimeMs = new Date(pos.fixTime).getTime();
      fixTimeRef.current[vehicleId] = fixTimeMs;
      const isStale = !isMine && now - fixTimeMs > STALE_THRESHOLD_MS;

      if (markersRef.current[vehicleId]) {
        const marker = markersRef.current[vehicleId];
        glideMarkerTo(
          marker,
          vehicleId,
          lngLat,
          previousFixAt ? now - previousFixAt : undefined,
        );
        updateVehicleMarkerHeading(marker.getElement(), pos.deviceId, pos.course, pos.speed, map.getBearing());
        setVehicleMarkerStale(marker.getElement(), isStale);
        // Módulo círculo de precisión del vehículo (No modificar)
        setVehicleMarkerAccuracy(marker.getElement(), map, pos.latitude, pos.longitude, pos.accuracy);
        return;
      }

      const color = isMine ? colors.myVehicle : colors.otherVehicle;
      const el = createVehicleMarkerElement({ deviceId: pos.deviceId, isMine, color, clickable: false });
      updateVehicleMarkerHeading(el, pos.deviceId, pos.course, pos.speed, map.getBearing());
      setVehicleMarkerStale(el, isStale);
      setVehicleMarkerAccuracy(el, map, pos.latitude, pos.longitude, pos.accuracy); // Módulo círculo de precisión del vehículo (No modificar)

      markersRef.current[vehicleId] = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
    });
  }, [map, loaded, fleet, myDeviceId, equipment]);

  // Módulo círculo de precisión del vehículo (No modificar)
  // el círculo es en pixeles de pantalla real (no metros) - al hacer zoom hay que recalcular
  // el tamaño de todos aunque no haya llegado una posición nueva
  useEffect(() => {
    if (!map) return;

    const handler = () => {
      Object.entries(markersRef.current).forEach(([vehicleId, marker]) => {
        const deviceId = vehicleId.replace(/^vehicle-/, '');
        const lngLat = marker.getLngLat();
        setVehicleMarkerAccuracy(marker.getElement(), map, lngLat.lat, lngLat.lng, accuracyRef.current[deviceId]);
      });
    };
    map.on('zoom', handler);
    return () => {
      map.off('zoom', handler);
    };
  }, [map]);

  // modo "orientado al frente" - cuando el mapa gira (por seguimiento automatico, ver follow()
  // arriba), la orientacion EN PANTALLA de cada flecha debe recalcularse de inmediato para seguir
  // apuntando hacia su rumbo geografico real, no quedarse con el angulo de antes de girar
  useEffect(() => {
    if (!map) return;

    const handler = () => {
      const bearing = map.getBearing();
      Object.values(markersRef.current).forEach((marker) => {
        realignVehicleMarkerToBearing(marker.getElement(), bearing);
      });
    };
    map.on('rotate', handler);
    return () => {
      map.off('rotate', handler);
    };
  }, [map]);

  useEffect(() => {
    Object.entries(markersRef.current).forEach(([vehicleId, marker]) => {
      const deviceId = vehicleId.replace(/^vehicle-/, '');
      setVehicleMarkerThreat(marker.getElement(), deviceId === threatDeviceId);
    });
  }, [threatDeviceId, fleet]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      Object.entries(markersRef.current).forEach(([vehicleId, marker]) => {
        const deviceId = vehicleId.replace(/^vehicle-/, '');
        if (deviceId === myDeviceId) {
          // mi propio vehículo siempre se ve azul para mí, sin importar conexión/GPS - el rojo
          // solo tiene sentido para saber si PERDÍ VISTA de otro vehículo, no de mí mismo
          setVehicleMarkerStale(marker.getElement(), false);
          return;
        }
        const fixTime = fixTimeRef.current[vehicleId];
        const isStale = !fixTime || now - fixTime > STALE_THRESHOLD_MS;
        setVehicleMarkerStale(marker.getElement(), isStale);
      });
    }, STALE_CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [myDeviceId]);

  return <div id="op-map" ref={containerRef} />;
});
