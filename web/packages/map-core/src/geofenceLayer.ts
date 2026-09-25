import type { Geofence, GeofenceType } from '@gaga-gps/shared-types';
import type { Feature, FeatureCollection, LineString, Polygon } from 'geojson';
import type { FilterSpecification, GeoJSONSource, Map as MaplibreMap } from 'maplibre-gl';
import { useEffect } from 'react';

const METERS_PER_DEG_LAT = 111320;

export function circleToPolygon(
  lat: number,
  lon: number,
  radiusMeters: number,
  points = 32,
): Polygon {
  const coords: [number, number][] = [];
  for (let i = 0; i <= points; i++) {
    const angle = (i / points) * 2 * Math.PI;
    const dLat = (radiusMeters / METERS_PER_DEG_LAT) * Math.cos(angle);
    const dLon =
      (radiusMeters / (METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180))) * Math.sin(angle);
    coords.push([lon + dLon, lat + dLat]);
  }
  return { type: 'Polygon', coordinates: [coords] };
}

export function lineToBufferPolygon(lineGeometry: LineString, halfWidthMeters: number): Polygon {
  const coords = lineGeometry.coordinates;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    const prev = coords[i - 1] || coords[i];
    const next = coords[i + 1] || coords[i];
    const latRad = (lat * Math.PI) / 180;
    const mPerLat = METERS_PER_DEG_LAT;
    const mPerLon = METERS_PER_DEG_LAT * Math.cos(latRad);
    const dx = (next[0] - prev[0]) * mPerLon;
    const dy = (next[1] - prev[1]) * mPerLat;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const perpX = -dy / len;
    const perpY = dx / len;
    const offLon = (perpX * halfWidthMeters) / mPerLon;
    const offLat = (perpY * halfWidthMeters) / mPerLat;
    left.push([lon + offLon, lat + offLat]);
    right.push([lon - offLon, lat - offLat]);
  }
  return { type: 'Polygon', coordinates: [[...left, ...right.reverse(), left[0]]] };
}

// duplicado a proposito en backend/src/utils/geoFormats.ts (GEOFENCE_COLORS) - replicar ahi
export const GEOFENCE_COLORS: Record<GeofenceType, string> = {
  forbidden: '#212121',
  danger: '#ff1f3d',
  warning: '#ffb300',
  authorized_route: '#ff6d00',
  allowed: '#00c853',
  parking: '#2979ff',
  discharge: '#a1662f',
  maintenance: '#8e24aa',
  carga: '#00acc1',
};

function colorForGeofence(g: Geofence): string {
  return GEOFENCE_COLORS[g.type] ?? GEOFENCE_COLORS.warning;
}

function buildGeofenceFeatures(geofences: Geofence[], highlightedId?: number | null): Feature[] {
  const features: Feature[] = [];

  (geofences || []).forEach((g) => {
    const color = colorForGeofence(g);
    const highlighted = g.id === highlightedId;

    switch (g.shapeType) {
      case 'polygon':
        features.push({
          type: 'Feature',
          properties: { color, highlighted, filled: g.filled },
          geometry: g.geometry,
        });
        break;

      case 'polyline': {
        // una sola franja del ancho configurado, color del tipo real (ya no hay margen extra de
        // escalada - la severidad la decide el tipo, no la distancia)
        features.push({
          type: 'Feature',
          properties: { color, highlighted },
          geometry: lineToBufferPolygon(g.geometry, g.corridorWidthMeters),
        });
        // la linea desnuda ademas de la franja: es sobre ella que se acomodan las flechas de
        // sentido (symbol-placement: 'line' necesita una LineString, no el poligono del corredor)
        const direction = g.routeDirection ?? 'both';
        if (direction !== 'both') {
          features.push({
            type: 'Feature',
            // 'backward' se recorre al reves del orden de dibujo, asi que la flecha apunta al otro
            // lado - se invierte el caracter en vez de invertir la geometria, mas barato y evita
            // que el resto de las capas vean una linea distinta a la real
            properties: { color, arrow: direction === 'forward' ? '▶' : '◀' },
            geometry: g.geometry,
          });
        }
        break;
      }

      case 'circle':
      default:
        features.push({
          type: 'Feature',
          properties: { color, highlighted },
          geometry: circleToPolygon(g.center.lat, g.center.lon, g.radiusMeters),
        });
    }
  });

  return features;
}

// exportada para poder verificar en pruebas que capa filtra que feature (ver bug del relleno
// fantasma en geofenceLayer.test.ts) - fuera de eso la usa solo useGeofenceLayer
export function renderGeofences(map: MaplibreMap, geofences: Geofence[], highlightedId?: number | null): void {
  if (!map.isStyleLoaded()) {
    map.once('idle', () => renderGeofences(map, geofences, highlightedId));
    return;
  }

  const geojson: FeatureCollection = {
    type: 'FeatureCollection',
    features: buildGeofenceFeatures(geofences, highlightedId),
  };
  const source = map.getSource('geofences-preview') as GeoJSONSource | undefined;

  if (source) {
    source.setData(geojson);
  } else {
    map.addSource('geofences-preview', { type: 'geojson', data: geojson });
    // La feature de flechas es una LineString desnuda que SOLO existe para colocar los simbolos
    // encima. Hay que excluirla de relleno y borde: una capa 'fill' trata una LineString como si
    // fuera un anillo de poligono y la cierra sola, lo que pintaba un area falsa enorme sobre el
    // mapa (bug real reportado con captura, en los 3 paneles a la vez).
    const notArrow: FilterSpecification = ['!', ['has', 'arrow']];
    map.addLayer({
      id: 'geofences-fill',
      type: 'fill',
      source: 'geofences-preview',
      filter: notArrow,
      // poligono 'sin relleno' (filled=false) se dibuja solo con su linea de borde (capa
      // geofences-line, sin cambios) - la franja de alerta (corridorWidthMeters) no se dibuja,
      // solo se explica como texto en el panel de edicion
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['==', ['get', 'filled'], false], 0, 0.3] },
    });
    map.addLayer({
      id: 'geofences-line',
      type: 'line',
      source: 'geofences-preview',
      filter: notArrow,
      paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 1 },
    });
    // sentido de recorrido de las rutas de un solo sentido. Se usa un caracter de texto y no un
    // icono para no tener que cargar un sprite - asi funciona igual sin conexion, que es el caso
    // real del Operador. symbol-placement 'line' lo repite a lo largo y lo orienta con la linea.
    map.addLayer({
      id: 'geofences-direction',
      type: 'symbol',
      source: 'geofences-preview',
      filter: ['has', 'arrow'],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 70,
        'text-field': ['get', 'arrow'],
        'text-size': 15,
        'text-rotation-alignment': 'map',
        'text-keep-upright': false,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#0b0d10',
        'text-halo-width': 1.5,
      },
    });
    map.addLayer({
      id: 'geofences-highlight',
      type: 'line',
      source: 'geofences-preview',
      filter: ['==', ['get', 'highlighted'], true],
      paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-opacity': 0.9 },
    });
  }
}

const HIGHLIGHT_PULSE_MS = 700;

export function useGeofenceLayer(
  map: MaplibreMap | null,
  mapLoaded: boolean,
  geofences: Geofence[],
  highlightedGeofenceId?: number | null,
): void {
  useEffect(() => {
    if (!map || !mapLoaded) return;
    renderGeofences(map, geofences, highlightedGeofenceId);
  }, [map, mapLoaded, geofences, highlightedGeofenceId]);

  useEffect(() => {
    if (!map || !mapLoaded || !highlightedGeofenceId) return;

    let growing = true;
    const interval = setInterval(() => {
      if (!map.getLayer('geofences-highlight')) return;
      growing = !growing;
      map.setPaintProperty('geofences-highlight', 'line-width', growing ? 6 : 3);
      map.setPaintProperty('geofences-highlight', 'line-opacity', growing ? 1 : 0.5);
    }, HIGHLIGHT_PULSE_MS);

    return () => clearInterval(interval);
  }, [map, mapLoaded, highlightedGeofenceId]);
}
