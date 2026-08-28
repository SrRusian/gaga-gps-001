import type { Feature, FeatureCollection } from 'geojson';
import type { GeoJSONSource, Map as MaplibreMap } from 'maplibre-gl';
import { useEffect } from 'react';
import { circleToPolygon } from './geofenceLayer';

export interface EquipmentMarkerData {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  swingRadiusMeters: number;
  safetyRadiusMeters: number;
  linkedDeviceId?: string | null;
}

export const EQUIPMENT_CORE_COLOR = '#f0a83c';
export const EQUIPMENT_OUTER_COLOR = '#4f8ff0';
const CORE_COLOR = EQUIPMENT_CORE_COLOR;
const OUTER_COLOR = EQUIPMENT_OUTER_COLOR;

function buildOuterFeatures(equipment: EquipmentMarkerData[]): Feature[] {
  return equipment.map((eq) => ({
    type: 'Feature',
    properties: { id: eq.id, name: eq.name },
    geometry: circleToPolygon(eq.latitude, eq.longitude, eq.safetyRadiusMeters),
  }));
}

function buildCoreFeatures(equipment: EquipmentMarkerData[]): Feature[] {
  return equipment.map((eq) => ({
    type: 'Feature',
    properties: { id: eq.id, name: eq.name },
    geometry: circleToPolygon(eq.latitude, eq.longitude, eq.swingRadiusMeters),
  }));
}

function renderEquipment(map: MaplibreMap, equipment: EquipmentMarkerData[]): void {
  if (!map.isStyleLoaded()) {
    map.once('idle', () => renderEquipment(map, equipment));
    return;
  }

  const outerGeojson: FeatureCollection = {
    type: 'FeatureCollection',
    features: buildOuterFeatures(equipment),
  };
  const coreGeojson: FeatureCollection = {
    type: 'FeatureCollection',
    features: buildCoreFeatures(equipment),
  };

  const outerSource = map.getSource('equipment-safety-preview') as GeoJSONSource | undefined;
  const coreSource = map.getSource('equipment-swing-preview') as GeoJSONSource | undefined;

  if (outerSource && coreSource) {
    outerSource.setData(outerGeojson);
    coreSource.setData(coreGeojson);
    return;
  }

  map.addSource('equipment-safety-preview', { type: 'geojson', data: outerGeojson });
  map.addLayer({
    id: 'equipment-safety-fill',
    type: 'fill',
    source: 'equipment-safety-preview',
    paint: { 'fill-color': OUTER_COLOR, 'fill-opacity': 0.12 },
  });
  map.addLayer({
    id: 'equipment-safety-line',
    type: 'line',
    source: 'equipment-safety-preview',
    paint: { 'line-color': OUTER_COLOR, 'line-width': 2, 'line-dasharray': [2, 1] },
  });

  map.addSource('equipment-swing-preview', { type: 'geojson', data: coreGeojson });
  map.addLayer({
    id: 'equipment-swing-fill',
    type: 'fill',
    source: 'equipment-swing-preview',
    paint: { 'fill-color': CORE_COLOR, 'fill-opacity': 0.35 },
  });
  map.addLayer({
    id: 'equipment-swing-line',
    type: 'line',
    source: 'equipment-swing-preview',
    paint: { 'line-color': CORE_COLOR, 'line-width': 2 },
  });
}

export function useEquipmentLayer(
  map: MaplibreMap | null,
  mapLoaded: boolean,
  equipment: EquipmentMarkerData[],
): void {
  useEffect(() => {
    if (!map || !mapLoaded) return;
    renderEquipment(map, equipment);
  }, [map, mapLoaded, equipment]);
}
