/**
 * satelliteLayers.ts
 *
 * ÚNICA implementación de la sincronización de capas satelitales
 * (mapas importados en Admin) y del modo Calles/Satelital/Mixto -
 * antes duplicada 4 veces (Operador, Supervisor, y 2 mapas de
 * Admin). Incluye el fix de orden de capas (beforeId): las capas
 * satelitales siempre se insertan debajo de "geofences-fill" si ya
 * existe, para que las geocercas queden garantizadas por encima.
 */
import type { ActiveMap } from '@gaga-gps/shared-types';
import type { Map as MaplibreMap, RasterLayerSpecification } from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { OSM_LAYER_ID } from './useMapLibreMap';
import type { MapMode } from './mapMode';

function applyMapModeToMap(map: MaplibreMap, mode: MapMode, activeSatelliteIds: number[]): void {
  const showOsm = mode === 'streets' || mode === 'hybrid';
  const showSat = mode === 'satellite' || mode === 'hybrid';
  const satOpacity = mode === 'hybrid' ? 0.9 : 1;
  const osmOpacity = mode === 'hybrid' ? 0.35 : 1;

  if (map.getLayer(OSM_LAYER_ID)) {
    map.setLayoutProperty(OSM_LAYER_ID, 'visibility', showOsm ? 'visible' : 'none');
    map.setPaintProperty(OSM_LAYER_ID, 'raster-opacity', osmOpacity);
  }

  activeSatelliteIds.forEach((id) => {
    const layerId = `sat-${id}`;
    if (!map.getLayer(layerId)) return;
    map.setLayoutProperty(layerId, 'visibility', showSat ? 'visible' : 'none');
    map.setPaintProperty(layerId, 'raster-opacity', satOpacity);
  });
}

/**
 * Reconstrucción completa en cada cambio - con el puñado de mapas
 * que maneja un sitio como este, es más simple y robusto que un
 * diff incremental, y garantiza el orden (viejo→nuevo = abajo→arriba).
 */
export function useSatelliteLayers(
  map: MaplibreMap | null,
  mapLoaded: boolean,
  activeMaps: ActiveMap[],
  mode: MapMode,
  /**
   * Capa por debajo de la cual insertar el satelital, si ya existe
   * - por default "geofences-fill" (Operador/Supervisor/Admin
   * geocercas). El mapa de Historial de Admin no tiene geocercas,
   * solo la línea de recorrido ("route-line"), así que la pasa
   * explícita para quedar debajo de esa en vez.
   */
  beforeLayerId = 'geofences-fill',
  /**
   * Encuadra la cámara una sola vez hacia las bounds del/los mapa(s)
   * activo(s) la primera vez que aparecen - Operador/Supervisor
   * arrancan con un centro fijo hardcodeado en su propio MapView que
   * puede quedar lejos del mapa importado (bug real encontrado en
   * campo: Supervisor arrancaba a ~17km de las bounds de "Alcaraces",
   * sin ningún indicio visual de que el mapa existía - el usuario
   * tenía que adivinar hacia dónde arrastrar). Admin NO lo activa -
   * en alcance "Global" puede haber mapas de varios proyectos a la
   * vez, saltar a las bounds de uno al azar sería más disruptivo que
   * útil, y Admin ya tiene controles propios (fitBounds de geocercas,
   * etc.) para navegar.
   */
  autoFitOnFirstLoad = false,
): void {
  const activeIdsRef = useRef<number[]>([]);
  const hasAutoFitRef = useRef(false);

  useEffect(() => {
    if (!map || !mapLoaded) return;

    activeIdsRef.current.forEach((id) => {
      if (map.getLayer(`sat-${id}`)) map.removeLayer(`sat-${id}`);
      if (map.getSource(`sat-${id}`)) map.removeSource(`sat-${id}`);
    });
    activeIdsRef.current = [];

    activeMaps.forEach((m) => {
      const sourceId = `sat-${m.id}`;
      map.addSource(sourceId, {
        type: 'raster',
        tiles: [`${window.location.origin}${m.tileUrlTemplate}`],
        tileSize: 256,
        minzoom: m.minZoom ?? 0,
        maxzoom: m.maxZoom ?? 19,
        ...(m.bounds
          ? { bounds: [m.bounds.minLon, m.bounds.minLat, m.bounds.maxLon, m.bounds.maxLat] }
          : {}),
      });

      // beforeLayerId (p. ej. "geofences-fill") sigue siendo la
      // prioridad - así el satelital queda por debajo tanto de las
      // geocercas guardadas como de las capas "gl-draw-*" de
      // mapbox-gl-draw (que en Admin → Geocercas existen desde que
      // se monta el control, no solo mientras se dibuja, y siempre
      // se agregan después de "geofences-fill" - quedan arriba sin
      // necesidad de mencionarlas aquí). Solo cuando beforeLayerId
      // TODAVÍA no existe (cero geocercas guardadas y alguien está
      // dibujando la primera) se usa la primera capa "gl-draw-*"
      // como ancla - si no, el satelital se insertaría hasta arriba
      // de todo y taparía ese dibujo en progreso.
      const beforeId = map.getLayer(beforeLayerId)
        ? beforeLayerId
        : map.getStyle()?.layers?.find((layer) => layer.id.startsWith('gl-draw-'))?.id;

      map.addLayer(
        {
          id: sourceId,
          type: 'raster',
          source: sourceId,
          // "raster-opacity-transition" es válido en el style spec de
          // MapLibre pero falta en esta versión de @types/maplibre-gl.
          paint: {
            'raster-opacity-transition': { duration: 300 },
          } as RasterLayerSpecification['paint'],
        },
        beforeId,
      );

      activeIdsRef.current.push(m.id);
    });

    if (autoFitOnFirstLoad && !hasAutoFitRef.current) {
      const withBounds = activeMaps.filter((m) => m.bounds);
      if (withBounds.length > 0) {
        hasAutoFitRef.current = true;
        const bounds = withBounds.map((m) => m.bounds!);
        const minLon = Math.min(...bounds.map((b) => b.minLon));
        const minLat = Math.min(...bounds.map((b) => b.minLat));
        const maxLon = Math.max(...bounds.map((b) => b.maxLon));
        const maxLat = Math.max(...bounds.map((b) => b.maxLat));
        map.fitBounds(
          [
            [minLon, minLat],
            [maxLon, maxLat],
          ],
          { padding: 80, maxZoom: 18, duration: 0 },
        );
      }
    }

    applyMapModeToMap(map, mode, activeIdsRef.current);
    // mode se maneja en su propio efecto abajo - no se incluye aquí
    // a propósito, para no reconstruir las capas solo por cambiar de modo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, mapLoaded, activeMaps, beforeLayerId]);

  useEffect(() => {
    if (!map || !mapLoaded) return;
    applyMapModeToMap(map, mode, activeIdsRef.current);
  }, [map, mapLoaded, mode]);
}
