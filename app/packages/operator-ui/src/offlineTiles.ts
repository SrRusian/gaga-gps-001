import maplibregl from 'maplibre-gl';
import { OSM_LAYER_ID } from '@gaga-gps/map-core';

// Cache persistente de tiles del mapa base para que la tableta no muestre zonas vacias sin red.
// Se apoya en un protocolo propio de MapLibre (addProtocol): cada tile pasa por aqui, se sirve del
// cache si ya esta, y si no se baja y se GUARDA. Es decir, todo lo que el operador ya vio con
// internet queda disponible sin internet, sin que nadie tenga que hacer nada.
//
// Cache Storage y no IndexedDB: guarda respuestas HTTP tal cual, que es exactamente lo que es un
// tile, y sobrevive a cerrar la app. Requiere contexto seguro - dentro de la app nativa el WebView
// sirve desde https://localhost, asi que siempre esta disponible; en un navegador por HTTP plano
// no existe y todo cae a fetch normal, sin romper nada.

const PROTOCOL = 'gagacache';
const CACHE_NAME = 'gaga-map-tiles-v1';
const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

// PNG transparente de 1x1 - sin red y sin cache es mejor un hueco limpio que un tile roto
const TRANSPARENT_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

// tope de seguridad del prefetch, no de operacion normal: evita que un radio grande a un zoom alto
// intente bajar cientos de miles de tiles y llene el almacenamiento de la tableta
const MAX_PREFETCH_TILES = 20000;
const PREFETCH_CONCURRENCY = 6;

function cacheStorageAvailable(): boolean {
  return typeof caches !== 'undefined';
}

async function openCache(): Promise<Cache | null> {
  if (!cacheStorageAvailable()) return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

// mismo estilo base que el resto de paneles pero con los tiles pasando por el cache
export function createCachedBaseMapStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: [`${PROTOCOL}://${OSM_TILE_URL}`],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [{ id: OSM_LAYER_ID, type: 'raster', source: 'osm', minzoom: 0 }],
  };
}

let registered = false;

export function registerOfflineTileProtocol(): void {
  if (registered) return;
  registered = true;

  maplibregl.addProtocol(PROTOCOL, async (params, abortController) => {
    const url = params.url.replace(`${PROTOCOL}://`, '');
    const cache = await openCache();

    const hit = await cache?.match(url);
    if (hit) return { data: await hit.arrayBuffer() };

    try {
      const response = await fetch(url, { signal: abortController.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // se guarda una copia ANTES de consumir el cuerpo - el original sigue sirviendo esta peticion
      cache?.put(url, response.clone()).catch(() => {
        // almacenamiento lleno: se sigue mostrando el mapa, solo no queda guardado
      });
      return { data: await response.arrayBuffer() };
    } catch (err) {
      if (abortController.signal.aborted) throw err;
      return { data: TRANSPARENT_PNG.buffer.slice(0) as ArrayBuffer };
    }
  });
}

function lonToTileX(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom);
}

function latToTileY(lat: number, zoom: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** zoom);
}

export interface PrefetchProgress {
  done: number;
  total: number;
}

// Descarga por adelantado el area de operacion completa (una mina es un area fija y chica), para
// que no dependa de que el operador ya haya pasado por ahi con internet. Salta lo que ya esta en
// cache, asi volver a llamarla solo baja lo que falta.
export async function prefetchTilesAround(
  latitude: number,
  longitude: number,
  radiusKm: number,
  minZoom = 10,
  maxZoom = 16,
  onProgress?: (progress: PrefetchProgress) => void,
): Promise<PrefetchProgress> {
  const cache = await openCache();
  if (!cache) return { done: 0, total: 0 };

  const urls: string[] = [];
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.cos((latitude * Math.PI) / 180));

  for (let z = minZoom; z <= maxZoom; z++) {
    const xMin = lonToTileX(longitude - dLon, z);
    const xMax = lonToTileX(longitude + dLon, z);
    // la Y de los tiles crece hacia el SUR, por eso el norte da el minimo
    const yMin = latToTileY(latitude + dLat, z);
    const yMax = latToTileY(latitude - dLat, z);
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        urls.push(OSM_TILE_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
        if (urls.length >= MAX_PREFETCH_TILES) break;
      }
      if (urls.length >= MAX_PREFETCH_TILES) break;
    }
    if (urls.length >= MAX_PREFETCH_TILES) break;
  }

  const progress: PrefetchProgress = { done: 0, total: urls.length };
  let cursor = 0;

  async function worker() {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      try {
        if (!(await cache!.match(url))) {
          const response = await fetch(url);
          if (response.ok) await cache!.put(url, response);
        }
      } catch {
        // un tile que falle no debe abortar la descarga completa - se reintenta la proxima vez
      }
      progress.done += 1;
      onProgress?.({ ...progress });
    }
  }

  await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
  return progress;
}

export async function getCachedTileCount(): Promise<number> {
  const cache = await openCache();
  if (!cache) return 0;
  return (await cache.keys()).length;
}

export async function clearTileCache(): Promise<void> {
  if (!cacheStorageAvailable()) return;
  try {
    await caches.delete(CACHE_NAME);
  } catch {
    // nada que limpiar
  }
}
