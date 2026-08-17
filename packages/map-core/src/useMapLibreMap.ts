/**
 * useMapLibreMap.ts
 *
 * Inicializa un mapa MapLibre GL dentro de un contenedor y expone
 * cuándo terminó de cargar - boilerplate común a las 3 apps
 * (Operador, Supervisor, y los 2 mapas de Admin).
 */
import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';

export const OSM_LAYER_ID = 'osm-layer';

/** Estilo base común - capa de calles OSM, id fijo (OSM_LAYER_ID) que el resto de map-core espera encontrar. */
export function createBaseMapStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        // maxzoom aquí (en la fuente, no solo en la capa de abajo) es
        // lo que le dice a MapLibre que no pida tiles a la red más
        // allá de z19 - OSM no los sirve (devuelve 400, y sin headers
        // CORS en el error, el navegador lo reporta como bloqueo
        // CORS). Sin esto, MapLibre sobre-zoomea de más y sigue
        // pidiendo tiles que no existen. El maxzoom de la capa solo
        // controla visibilidad, no qué se pide a la red.
        maxzoom: 19,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [
      {
        id: OSM_LAYER_ID,
        type: 'raster',
        source: 'osm',
        minzoom: 0,
        maxzoom: 19,
      },
    ],
  };
}

export interface UseMapLibreMapOptions {
  center: [number, number];
  zoom: number;
  style?: maplibregl.StyleSpecification;
}

export interface UseMapLibreMapResult {
  map: maplibregl.Map | null;
  loaded: boolean;
}

/**
 * @param containerRef - ref al div contenedor del mapa (debe tener altura definida por CSS)
 */
export function useMapLibreMap(
  containerRef: React.RefObject<HTMLDivElement | null>,
  { center, zoom, style }: UseMapLibreMapOptions,
): UseMapLibreMapResult {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: style ?? createBaseMapStyle(),
      center,
      zoom,
    });
    mapRef.current = map;
    map.on('load', () => setLoaded(true));

    return () => {
      map.remove();
      mapRef.current = null;
      setLoaded(false);
    };
    // Se inicializa una sola vez al montar - center/zoom/style son el
    // punto de partida, no props reactivas (igual que la versión
    // vanilla original).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { map: mapRef.current, loaded };
}
