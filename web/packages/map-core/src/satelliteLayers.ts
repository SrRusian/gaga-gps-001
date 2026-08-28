import { getApiBaseUrl } from '@gaga-gps/client';
import type { ActiveMap } from '@gaga-gps/shared-types';
import type { Map as MaplibreMap, RasterLayerSpecification } from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { OSM_LAYER_ID } from './useMapLibreMap';
import type { MapMode } from './mapMode';

// la satelital debe quedar siempre justo encima del mapa base y debajo de TODO lo demás
// (geocercas, equipo, incidentes, vehículos) - buscar una capa con nombre específico como
// referencia es frágil (puede no existir todavía en el momento exacto en que esto se re-ejecuta,
// dejando la satelital hasta arriba de todo por accidente); la capa base sí es una garantía real,
// se crea antes que cualquier hook de este proyecto
function firstLayerAfterBaseMap(map: MaplibreMap): string | undefined {
  const layers = map.getStyle()?.layers ?? [];
  const baseIndex = layers.findIndex((layer) => layer.id === OSM_LAYER_ID);
  if (baseIndex === -1) return undefined;
  const next = layers[baseIndex + 1];
  return next && !next.id.startsWith('sat-') ? next.id : undefined;
}

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

export function useSatelliteLayers(
  map: MaplibreMap | null,
  mapLoaded: boolean,
  activeMaps: ActiveMap[],
  mode: MapMode,
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

    // se calcula una sola vez, antes de agregar ninguna - así varios mapas satelitales activos
    // a la vez quedan agrupados consecutivos en ese mismo punto, no cada uno buscando de nuevo
    // (lo que dejaría al segundo/tercero saltando hasta arriba de todo)
    const beforeId = firstLayerAfterBaseMap(map);

    activeMaps.forEach((m) => {
      const sourceId = `sat-${m.id}`;
      // getApiBaseUrl() vacio = mismo origen (navegador normal); en la app Android el WebView
      // carga los assets desde su propio origen local, distinto al backend real - sin esto las
      // teselas satelitales se pedían contra el origen equivocado y nunca llegaban
      map.addSource(sourceId, {
        type: 'raster',
        tiles: [`${getApiBaseUrl() || window.location.origin}${m.tileUrlTemplate}`],
        tileSize: 256,
        minzoom: m.minZoom ?? 0,
        maxzoom: m.maxZoom ?? 19,
        ...(m.bounds
          ? { bounds: [m.bounds.minLon, m.bounds.minLat, m.bounds.maxLon, m.bounds.maxLat] }
          : {}),
      });

      map.addLayer(
        {
          id: sourceId,
          type: 'raster',
          source: sourceId,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, mapLoaded, activeMaps]);

  useEffect(() => {
    if (!map || !mapLoaded) return;
    applyMapModeToMap(map, mode, activeIdsRef.current);
  }, [map, mapLoaded, mode]);
}
