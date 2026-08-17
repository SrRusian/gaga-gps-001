/**
 * geofenceLayer.ts
 *
 * ÚNICA implementación del renderizado de geocercas (círculo,
 * polígono, polilínea/corredor) sobre MapLibre - antes duplicada 4
 * veces. circleToPolygon/lineToBufferPolygon se exportan sueltas
 * porque Admin también las necesita para la previsualización en vivo
 * mientras se dibuja una geocerca nueva.
 */
import type { Geofence } from '@gaga-gps/shared-types';
import type { Feature, FeatureCollection, LineString, Polygon } from 'geojson';
import type { GeoJSONSource, Map as MaplibreMap } from 'maplibre-gl';
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

// Colores saturados a propósito, no pastel - deben leerse
// distintivos a simple vista sobre calles Y sobre satelital, con
// suficiente opacidad para seguir viendo el terreno debajo (ver
// fill-opacity en renderGeofences). Un tono demasiado claro/pálido se
// pierde contra imagen satelital clara; estos son intencionalmente
// más intensos que un simple amarillo/rojo/azul de manual de estilo.
function colorForGeofence(g: Geofence): string {
  if (g.type === 'danger') return '#ff1f3d';
  if (g.type === 'parking') return '#2979ff';
  return '#ffb300';
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
          properties: { color, highlighted },
          geometry: g.geometry,
        });
        break;

      case 'polyline': {
        const margin = g.corridorDangerMarginMeters;
        if (margin) {
          features.push({
            type: 'Feature',
            properties: { color: '#ffb300', highlighted: false },
            geometry: lineToBufferPolygon(g.geometry, g.corridorWidthMeters + margin),
          });
        }
        features.push({
          type: 'Feature',
          properties: { color: '#00e676', highlighted },
          geometry: lineToBufferPolygon(g.geometry, g.corridorWidthMeters),
        });
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

function renderGeofences(map: MaplibreMap, geofences: Geofence[], highlightedId?: number | null): void {
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
    map.addLayer({
      id: 'geofences-fill',
      type: 'fill',
      source: 'geofences-preview',
      // Relleno translúcido (se sigue viendo el terreno debajo) pero
      // con un borde grueso y 100% opaco - el contorno es lo que debe
      // leerse "distintivo a la distancia", el relleno solo refuerza.
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.3 },
    });
    map.addLayer({
      id: 'geofences-line',
      type: 'line',
      source: 'geofences-preview',
      paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 1 },
    });
    // Capa aparte para el pulso de "geocerca con alerta activa" - se
    // anima variando line-width/line-opacity desde useGeofenceLayer,
    // sin tocar la capa base (evita redibujar todas las geocercas en
    // cada tick de la animación).
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

  // Pulso de opacidad/grosor en la geocerca resaltada - puramente
  // visual, no vuelve a calcular geometría (la capa ya está filtrada
  // por `highlighted` en renderGeofences).
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
