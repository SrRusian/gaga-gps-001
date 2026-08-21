import type { Feature, FeatureCollection } from 'geojson';
import type { GeoJSONSource, Map as MaplibreMap } from 'maplibre-gl';
import { useEffect } from 'react';
import { circleToPolygon } from './geofenceLayer';

export interface AccuracyMarkerData {
  deviceId: string;
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
}

const ACCURACY_COLOR = '#4f8ff0';
const MIN_RADIUS_METERS = 3;
const DEFAULT_RADIUS_METERS = 15;

function buildFeatures(items: AccuracyMarkerData[]): Feature[] {
  return items.map((item) => ({
    type: 'Feature',
    properties: { deviceId: item.deviceId },
    geometry: circleToPolygon(
      item.latitude,
      item.longitude,
      Math.max(item.accuracyMeters ?? DEFAULT_RADIUS_METERS, MIN_RADIUS_METERS),
    ),
  }));
}

function renderAccuracy(map: MaplibreMap, items: AccuracyMarkerData[]): void {
  if (!map.isStyleLoaded()) {
    map.once('idle', () => renderAccuracy(map, items));
    return;
  }

  const geojson: FeatureCollection = { type: 'FeatureCollection', features: buildFeatures(items) };
  const source = map.getSource('vehicle-accuracy') as GeoJSONSource | undefined;

  if (source) {
    source.setData(geojson);
    return;
  }

  map.addSource('vehicle-accuracy', { type: 'geojson', data: geojson });
  map.addLayer({
    id: 'vehicle-accuracy-fill',
    type: 'fill',
    source: 'vehicle-accuracy',
    paint: { 'fill-color': ACCURACY_COLOR, 'fill-opacity': 0.08 },
  });
  map.addLayer({
    id: 'vehicle-accuracy-line',
    type: 'line',
    source: 'vehicle-accuracy',
    paint: { 'line-color': ACCURACY_COLOR, 'line-width': 1, 'line-opacity': 0.35 },
  });
}

export function useVehicleAccuracyLayer(
  map: MaplibreMap | null,
  mapLoaded: boolean,
  items: AccuracyMarkerData[],
): void {
  useEffect(() => {
    if (!map || !mapLoaded) return;
    renderAccuracy(map, items);
  }, [map, mapLoaded, items]);
}
