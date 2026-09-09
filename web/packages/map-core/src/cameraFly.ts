import type { FitBoundsOptions, FlyToOptions, LngLatBoundsLike, Map as MaplibreMap } from 'maplibre-gl';

// Curva un poco mas pronunciada que el default de MapLibre (1.42) - el "alejar y volver a
// acercar" que ya se veia (sin querer) al editar una geocerca (fitBounds sin duration fija)
// resulto ser la animacion mas agradable del proyecto, asi que se estandariza aqui para
// cualquier centrado de camara: seleccionar un vehiculo, editar una geocerca/equipo, "centrar en
// mi" del Operador, etc. `speed` (no `duration` fija) deja que MapLibre calcule el tiempo segun
// la distancia real - un salto corto es rapido, uno largo se toma su tiempo, en vez de que todos
// duren lo mismo sin importar que tan lejos este el destino.
const FLY_CURVE = 1.6;
const FLY_SPEED = 1.3;
// tope de seguridad - sin esto, centrar en algo muy lejano (ej. cambiar de scope Global a un
// proyecto en otra parte del mundo) podria animar por varios segundos
const FLY_MAX_DURATION_MS = 2500;

/**
 * Centra la camara en un punto con la animacion "fly" estandar del proyecto. `essential` se deja
 * en su default (false) a proposito - asi MapLibre respeta prefers-reduced-motion del sistema
 * (salta directo, sin animar, para quien lo tenga activado) en vez de forzar el vuelo siempre.
 */
export function flyToPoint(
  map: MaplibreMap | null | undefined,
  lat: number,
  lon: number,
  options: FlyToOptions = {},
): void {
  if (!map) return;
  map.flyTo({
    center: [lon, lat],
    curve: FLY_CURVE,
    speed: FLY_SPEED,
    maxDuration: FLY_MAX_DURATION_MS,
    ...options,
  });
}

/**
 * Encuadra unos limites (editar un poligono/corredor, enmarcar 2 vehiculos, un recorrido de
 * historial) con la misma animacion "fly" estandar - mismo criterio que flyToPoint.
 */
export function flyToBounds(
  map: MaplibreMap | null | undefined,
  bounds: LngLatBoundsLike,
  options: FitBoundsOptions = {},
): void {
  if (!map) return;
  map.fitBounds(bounds, {
    padding: 80,
    maxZoom: 17,
    curve: FLY_CURVE,
    speed: FLY_SPEED,
    maxDuration: FLY_MAX_DURATION_MS,
    ...options,
  });
}
