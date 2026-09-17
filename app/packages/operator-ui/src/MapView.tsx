import {
  createVehicleMarkerElement,
  flyToBounds,
  flyToPoint,
  realignVehicleMarkerToBearing,
  resolveVehicleCourse,
  setVehicleMarkerAccuracy,
  setVehicleMarkerFootprint,
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
import {
  applyHeadingOffset,
  INITIAL_HEADING_OFFSET_STATE,
  updateHeadingOffset,
  type HeadingOffsetState,
} from './headingCalibration';
import { useDeviceOrientation } from './useDeviceOrientation';

const STALE_THRESHOLD_MS = 3000;
const STALE_CHECK_INTERVAL_MS = 1000;
const GLIDE_MAX_MS = 1000;
const GLIDE_MIN_MS = 200;
const GLIDE_FALLBACK_MS = 800;

// Extrapolacion ("dead reckoning") de la flecha PROPIA entre un fix real y el siguiente - a
// diferencia de glideMarkerTo (que anima hacia un punto que ya llego), esto proyecta la posicion
// hacia adelante usando velocidad/rumbo del ultimo fix real mientras no llega uno nuevo, para que
// el movimiento se vea continuo en vez de "saltar" cada vez que llega un fix (1/seg con GPS
// interno, hasta 10/seg con RTK via el evento nativo rtkFix - ver useDeviceGeolocation.ts). Solo
// aplica al vehiculo propio - los demas siguen usando glideMarkerTo sin cambios.
const DEAD_RECKONING_MAX_MS = 3000; // sin fix nuevo mas alla de esto, se deja de proyectar (mismo umbral que STALE_THRESHOLD_MS)
const DEAD_RECKONING_MIN_SPEED_MPS = 0.5; // igual que MIN_MOVING_SPEED_MPS de vehicleMarker.ts - evita "mover" el marcador por ruido de GPS estando detenido
const DEAD_RECKONING_SMOOTHING_TAU_MS = 120; // que tan rapido el marcador alcanza el punto proyectado - bajo a proposito, casi sin retraso perceptible
// duplicado a proposito de vehicleMarker.ts (METERS_PER_DEG_LAT) - ese modulo no lo exporta y no
// vale la pena acoplar operator-ui a su detalle interno por una sola constante
const METERS_PER_DEG_LAT = 111320;

function metersToLngLatDelta(
  atLat: number,
  speedMps: number,
  courseDeg: number,
  elapsedSeconds: number,
): [number, number] {
  const distanceM = speedMps * elapsedSeconds;
  const courseRad = (courseDeg * Math.PI) / 180;
  const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos((atLat * Math.PI) / 180);
  const dLat = (distanceM * Math.cos(courseRad)) / METERS_PER_DEG_LAT;
  const dLng = metersPerDegLon > 1 ? (distanceM * Math.sin(courseRad)) / metersPerDegLon : 0;
  return [dLng, dLat];
}

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
  // silueta real del vehiculo (largo/ancho, metros) por deviceId - ver useVehicleFootprints.ts.
  // Sin entrada para un deviceId = sin tipo asignado, ese marcador no dibuja silueta.
  deviceFootprints?: Record<string, { lengthMeters: number | null; widthMeters: number | null }>;
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
    deviceFootprints = {},
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
  // shadow del prop deviceFootprints, igual que accuracyRef, para que el handler de zoom (solo
  // depende de [map]) siempre lea el valor mas reciente
  const footprintsRef = useRef(deviceFootprints);
  footprintsRef.current = deviceFootprints;
  const glideFrameRef = useRef<Record<string, number>>({});

  // ver comentario de DEAD_RECKONING_* arriba - estado del vehiculo propio unicamente
  const myDeviceIdRef = useRef<string | null>(myDeviceId);
  myDeviceIdRef.current = myDeviceId;
  const ownFixRef = useRef<{ lng: number; lat: number; speedMps: number; courseDeg: number; atMs: number } | null>(null);
  const ownDisplayRef = useRef<{ lng: number; lat: number } | null>(null);

  // brujula del propio tablet - solo se usa como respaldo del rumbo GPS mientras el vehiculo esta
  // detenido (ver resolveOwnCourse). Mientras se mueve, el rumbo GPS sigue mandando sin cambio.
  const compassHeading = useDeviceOrientation();
  const compassHeadingRef = useRef<number | null>(compassHeading);
  compassHeadingRef.current = compassHeading;

  // desfase de montaje de la tablet (soporte girado/chueco en la cabina) - se aprende solo
  // mientras el vehiculo va a velocidad confiable (ver headingCalibration.ts) comparando el rumbo
  // GPS real contra lo que reporta la brujula en ese momento, y se aplica encima de la brujula solo
  // cuando el vehiculo esta detenido - sin esto, un soporte girado 30° hace que el mapa "brinque"
  // ese angulo justo al frenar.
  const headingOffsetRef = useRef<HeadingOffsetState>(INITIAL_HEADING_OFFSET_STATE);

  // envuelve resolveVehicleCourse (map-core, compartido con Admin/Supervisor - no se toca) solo
  // para el vehiculo propio: si esta detenido y hay lectura de brujula, la usa (corregida por el
  // desfase de montaje aprendido) en vez de quedarse con el ultimo rumbo GPS conocido (que puede
  // llevar minutos sin actualizarse). Con movimiento real, se comporta identico a
  // resolveVehicleCourse - el GPS sigue siendo la unica fuente, mismo criterio que ya se aplico
  // antes al descartar el magnetometro para frente/reversa del chasis (ahi la tolerancia necesaria
  // era mucho mas fina que "hacia donde apunta el mapa").
  function resolveOwnCourse(deviceId: string, course: number | undefined, speed: number | undefined) {
    const resolved = resolveVehicleCourse(deviceId, course, speed);
    if (resolved.stopped && compassHeadingRef.current !== null) {
      return {
        course: applyHeadingOffset(compassHeadingRef.current, headingOffsetRef.current.offsetDeg),
        stopped: true,
      };
    }
    return resolved;
  }

  // mismo cuerpo que updateVehicleMarkerHeading (map-core) pero con brujula de respaldo detenido -
  // solo para el marcador propio, sin tocar el modulo compartido con Admin/Supervisor (que nunca
  // deben usar la brujula, no tienen ese sensor ni lo necesitan). Lee compassHeadingRef/
  // headingOffsetRef directo (no via resolveOwnCourse) para que esta funcion siga siendo "estable"
  // a ojos de react-hooks/exhaustive-deps (solo refs/imports, igual que glideMarkerTo) y no obligue
  // al efecto de fleet de mas abajo a re-ejecutarse en cada lectura nueva de la brujula.
  function applyOwnMarkerHeading(el: HTMLElement, deviceId: string, course: number | undefined, speed: number | undefined, mapBearing: number) {
    const arrow = el.querySelector<HTMLDivElement>('.vehicle-marker__arrow');
    if (!arrow) return;
    const resolved = resolveVehicleCourse(deviceId, course, speed);
    const resolvedCourse =
      resolved.stopped && compassHeadingRef.current !== null
        ? applyHeadingOffset(compassHeadingRef.current, headingOffsetRef.current.offsetDeg)
        : resolved.course;
    arrow.dataset.course = String(resolvedCourse);
    arrow.style.transform = `rotate(${resolvedCourse - mapBearing}deg)`;
    // "stopped" sigue reflejando movimiento REAL (no si hay brujula) - un vehiculo detenido se ve
    // detenido aunque ahora sepamos hacia donde apunta
    arrow.style.opacity = resolved.stopped ? '0.55' : '1';

    const footprint = el.querySelector<HTMLDivElement>('.vehicle-marker__footprint');
    if (footprint) footprint.style.transform = `rotate(${resolvedCourse - mapBearing}deg)`;
  }

  useEffect(() => {
    let rafId: number;
    let lastFrameAt: number | null = null;

    function tick(now: number) {
      const dtMs = lastFrameAt === null ? 0 : now - lastFrameAt;
      lastFrameAt = now;

      const ownVehicleId = myDeviceIdRef.current ? `vehicle-${myDeviceIdRef.current}` : null;
      const marker = ownVehicleId ? markersRef.current[ownVehicleId] : null;
      const fix = ownFixRef.current;

      if (marker && fix) {
        const elapsedMs = Math.min(Date.now() - fix.atMs, DEAD_RECKONING_MAX_MS);
        const [dLng, dLat] =
          fix.speedMps >= DEAD_RECKONING_MIN_SPEED_MPS
            ? metersToLngLatDelta(fix.lat, fix.speedMps, fix.courseDeg, elapsedMs / 1000)
            : [0, 0];
        const targetLng = fix.lng + dLng;
        const targetLat = fix.lat + dLat;

        const current = ownDisplayRef.current ?? { lng: fix.lng, lat: fix.lat };
        const alpha = dtMs > 0 ? 1 - Math.exp(-dtMs / DEAD_RECKONING_SMOOTHING_TAU_MS) : 1;
        const nextLng = current.lng + (targetLng - current.lng) * alpha;
        const nextLat = current.lat + (targetLat - current.lat) * alpha;

        ownDisplayRef.current = { lng: nextLng, lat: nextLat };
        marker.setLngLat([nextLng, nextLat]);
      }

      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

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
      // reaccionan al 'rotate' del mapa). Se usa resolveOwnCourse (GPS + brujula de respaldo
      // detenido) en vez de congelarse en el ultimo rumbo GPS conocido mientras no hay movimiento.
      follow(lat: number, lon: number, course, speed) {
        if (!map) return;
        const { course: bearing } = resolveOwnCourse(myDeviceId ?? '', course, speed);
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
        if (myDeviceId && vehicleId === `vehicle-${myDeviceId}`) {
          ownFixRef.current = null;
          ownDisplayRef.current = null;
        }
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
      const footprint = deviceFootprints[pos.deviceId];

      // fixTime real del reporte (no "cuándo lo vio este navegador") - así al recargar la
      // página un vehículo ya offline se marca de inmediato, sin esperar un umbral completo
      const fixTimeMs = new Date(pos.fixTime).getTime();
      fixTimeRef.current[vehicleId] = fixTimeMs;
      const isStale = !isMine && now - fixTimeMs > STALE_THRESHOLD_MS;

      // vehiculo propio: el efecto de arriba (dead reckoning) es quien mueve el marcador entre
      // fixes reales - aqui solo se actualiza el fix base que ese efecto usa, nunca marker.setLngLat
      if (isMine) {
        // aprende el desfase de montaje mientras haya rumbo GPS real y lectura de brujula a la vez -
        // no hace nada si va lento (ver MIN_SPEED_MPS_FOR_CALIBRATION en headingCalibration.ts)
        if (pos.course !== undefined && compassHeadingRef.current !== null) {
          headingOffsetRef.current = updateHeadingOffset(
            headingOffsetRef.current,
            pos.course,
            compassHeadingRef.current,
            pos.speed ?? 0,
          );
        }

        const { course: resolvedCourse } = resolveVehicleCourse(pos.deviceId, pos.course, pos.speed);
        ownFixRef.current = {
          lng: pos.longitude,
          lat: pos.latitude,
          speedMps: pos.speed ?? 0,
          courseDeg: resolvedCourse,
          atMs: fixTimeMs,
        };
      }

      if (markersRef.current[vehicleId]) {
        const marker = markersRef.current[vehicleId];
        if (!isMine) {
          glideMarkerTo(
            marker,
            vehicleId,
            lngLat,
            previousFixAt ? now - previousFixAt : undefined,
          );
        }
        if (isMine) {
          applyOwnMarkerHeading(marker.getElement(), pos.deviceId, pos.course, pos.speed, map.getBearing());
        } else {
          updateVehicleMarkerHeading(marker.getElement(), pos.deviceId, pos.course, pos.speed, map.getBearing());
        }
        setVehicleMarkerStale(marker.getElement(), isStale);
        // Módulo círculo de precisión del vehículo (No modificar)
        setVehicleMarkerAccuracy(marker.getElement(), map, pos.latitude, pos.longitude, pos.accuracy);
        setVehicleMarkerFootprint(
          marker.getElement(),
          map,
          pos.latitude,
          pos.longitude,
          footprint?.lengthMeters,
          footprint?.widthMeters,
        );
        return;
      }

      const color = isMine ? colors.myVehicle : colors.otherVehicle;
      const el = createVehicleMarkerElement({ deviceId: pos.deviceId, isMine, color, clickable: false });
      if (isMine) {
        applyOwnMarkerHeading(el, pos.deviceId, pos.course, pos.speed, map.getBearing());
      } else {
        updateVehicleMarkerHeading(el, pos.deviceId, pos.course, pos.speed, map.getBearing());
      }
      setVehicleMarkerStale(el, isStale);
      setVehicleMarkerAccuracy(el, map, pos.latitude, pos.longitude, pos.accuracy); // Módulo círculo de precisión del vehículo (No modificar)
      setVehicleMarkerFootprint(el, map, pos.latitude, pos.longitude, footprint?.lengthMeters, footprint?.widthMeters);

      markersRef.current[vehicleId] = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
    });
  }, [map, loaded, fleet, myDeviceId, equipment, deviceFootprints]);

  // el círculo/la silueta son en pixeles de pantalla real (no metros) - al hacer zoom hay que
  // recalcular el tamaño de todos aunque no haya llegado una posición nueva (círculo de precisión:
  // Módulo, No modificar)
  useEffect(() => {
    if (!map) return;

    const handler = () => {
      Object.entries(markersRef.current).forEach(([vehicleId, marker]) => {
        const deviceId = vehicleId.replace(/^vehicle-/, '');
        const lngLat = marker.getLngLat();
        setVehicleMarkerAccuracy(marker.getElement(), map, lngLat.lat, lngLat.lng, accuracyRef.current[deviceId]);
        const footprint = footprintsRef.current[deviceId];
        setVehicleMarkerFootprint(
          marker.getElement(),
          map,
          lngLat.lat,
          lngLat.lng,
          footprint?.lengthMeters,
          footprint?.widthMeters,
        );
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
