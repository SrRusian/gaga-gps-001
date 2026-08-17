/**
 * incidentLayer.ts
 *
 * Renderizado de incidentes activos (alertas de peligro estilo
 * Waze/Uber) sobre MapLibre - dos anillos concéntricos, no uno solo:
 * un núcleo pequeño de radio fijo, siempre rojo sólido, marcando el
 * punto EXACTO reportado ("aquí está el problema"), y el anillo
 * exterior de siempre con el `radiusMeters` real del incidente
 * (la zona de aproximación que ya dispara `incident:nearby`) en el
 * color de su categoría, punteado. Antes solo existía el anillo
 * exterior - un vehículo lejano no tenía forma de distinguir a
 * simple vista el punto exacto del peligro dentro de una zona de
 * ~100m. Reutiliza `circleToPolygon` de geofenceLayer.ts.
 */
import type { Feature, FeatureCollection } from 'geojson';
import type { GeoJSONSource, Map as MaplibreMap } from 'maplibre-gl';
import { useEffect } from 'react';
import { circleToPolygon } from './geofenceLayer';

export interface IncidentMarkerData {
  id: number;
  category: 'obstacle' | 'accident' | 'traffic' | 'other';
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

// Radio fijo del núcleo - no viene del incidente (ese define el
// anillo de aproximación), es solo la marca visual del punto exacto.
const CORE_RADIUS_METERS = 15;
const CORE_COLOR = '#e5484d';

function colorForCategory(category: IncidentMarkerData['category']): string {
  if (category === 'accident') return '#e5484d';
  return '#f0a83c';
}

function buildOuterFeatures(incidents: IncidentMarkerData[]): Feature[] {
  return incidents.map((inc) => ({
    type: 'Feature',
    properties: { id: inc.id, color: colorForCategory(inc.category) },
    geometry: circleToPolygon(inc.latitude, inc.longitude, inc.radiusMeters),
  }));
}

function buildCoreFeatures(incidents: IncidentMarkerData[]): Feature[] {
  return incidents.map((inc) => ({
    type: 'Feature',
    properties: { id: inc.id },
    geometry: circleToPolygon(inc.latitude, inc.longitude, CORE_RADIUS_METERS),
  }));
}

function renderIncidents(map: MaplibreMap, incidents: IncidentMarkerData[]): void {
  if (!map.isStyleLoaded()) {
    map.once('idle', () => renderIncidents(map, incidents));
    return;
  }

  const outerGeojson: FeatureCollection = {
    type: 'FeatureCollection',
    features: buildOuterFeatures(incidents),
  };
  const coreGeojson: FeatureCollection = {
    type: 'FeatureCollection',
    features: buildCoreFeatures(incidents),
  };

  const outerSource = map.getSource('incidents-preview') as GeoJSONSource | undefined;
  const coreSource = map.getSource('incidents-core-preview') as GeoJSONSource | undefined;

  if (outerSource && coreSource) {
    outerSource.setData(outerGeojson);
    coreSource.setData(coreGeojson);
    return;
  }

  map.addSource('incidents-preview', { type: 'geojson', data: outerGeojson });
  map.addLayer({
    id: 'incidents-fill',
    type: 'fill',
    source: 'incidents-preview',
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.2 },
  });
  map.addLayer({
    id: 'incidents-line',
    type: 'line',
    source: 'incidents-preview',
    paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [2, 1] },
  });

  // Núcleo por encima del anillo exterior - sólido, sin punteado, para
  // que se distinga a simple vista de la zona de aproximación.
  map.addSource('incidents-core-preview', { type: 'geojson', data: coreGeojson });
  map.addLayer({
    id: 'incidents-core-fill',
    type: 'fill',
    source: 'incidents-core-preview',
    paint: { 'fill-color': CORE_COLOR, 'fill-opacity': 0.65 },
  });
  map.addLayer({
    id: 'incidents-core-line',
    type: 'line',
    source: 'incidents-core-preview',
    paint: { 'line-color': CORE_COLOR, 'line-width': 2 },
  });
}

export function useIncidentLayer(
  map: MaplibreMap | null,
  mapLoaded: boolean,
  incidents: IncidentMarkerData[],
): void {
  useEffect(() => {
    if (!map || !mapLoaded) return;
    renderIncidents(map, incidents);
  }, [map, mapLoaded, incidents]);
}
