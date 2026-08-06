/**
 * geofenceLayer.ts
 *
 * ÚNICA implementación del renderizado de geocercas (círculo,
 * polígono, polilínea/corredor) sobre MapLibre — antes duplicada 4
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

function buildGeofenceFeatures(geofences: Geofence[]): Feature[] {
  const features: Feature[] = [];

  (geofences || []).forEach((g) => {
    const color = g.type === 'danger' ? '#ff4444' : '#ffcc00';

    switch (g.shapeType) {
      case 'polygon':
        features.push({ type: 'Feature', properties: { color }, geometry: g.geometry });
        break;

      case 'polyline': {
        const margin = g.corridorDangerMarginMeters;
        if (margin) {
          features.push({
            type: 'Feature',
            properties: { color: '#ffcc00' },
            geometry: lineToBufferPolygon(g.geometry, g.corridorWidthMeters + margin),
          });
        }
        features.push({
          type: 'Feature',
          properties: { color: '#00ff88' },
          geometry: lineToBufferPolygon(g.geometry, g.corridorWidthMeters),
        });
        break;
      }

      case 'circle':
      default:
        features.push({
          type: 'Feature',
          properties: { color },
          geometry: circleToPolygon(g.center.lat, g.center.lon, g.radiusMeters),
        });
    }
  });

  return features;
}

function renderGeofences(map: MaplibreMap, geofences: Geofence[]): void {
  if (!map.isStyleLoaded()) {
    map.once('idle', () => renderGeofences(map, geofences));
    return;
  }

  const geojson: FeatureCollection = {
    type: 'FeatureCollection',
    features: buildGeofenceFeatures(geofences),
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
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 },
    });
    map.addLayer({
      id: 'geofences-line',
      type: 'line',
      source: 'geofences-preview',
      paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
    });
  }
}

export function useGeofenceLayer(
  map: MaplibreMap | null,
  mapLoaded: boolean,
  geofences: Geofence[],
): void {
  useEffect(() => {
    if (!map || !mapLoaded) return;
    renderGeofences(map, geofences);
  }, [map, mapLoaded, geofences]);
}
