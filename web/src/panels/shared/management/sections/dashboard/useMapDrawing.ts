import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import maplibregl from 'maplibre-gl';
import { useEffect, type MutableRefObject } from 'react';
import type { GeofencesAdmin } from './useGeofencesAdmin';
import type { EquipmentAdmin } from './useEquipmentAdmin';

const DRAW_COLOR = '#a855f7';
const DRAW_ACTIVE_COLOR = '#e879f9';

const DRAW_STYLES = [
  {
    id: 'gl-draw-polygon-fill',
    type: 'fill',
    filter: ['all', ['==', '$type', 'Polygon']],
    paint: {
      'fill-color': ['case', ['==', ['get', 'active'], 'true'], DRAW_ACTIVE_COLOR, DRAW_COLOR],
      'fill-opacity': 0.35,
    },
  },
  {
    id: 'gl-draw-lines',
    type: 'line',
    filter: ['any', ['==', '$type', 'LineString'], ['==', '$type', 'Polygon']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['case', ['==', ['get', 'active'], 'true'], DRAW_ACTIVE_COLOR, DRAW_COLOR],
      'line-width': 4,
    },
  },
  {
    id: 'gl-draw-point-outer',
    type: 'circle',
    filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'feature']],
    paint: {
      'circle-radius': ['case', ['==', ['get', 'active'], 'true'], 8, 6],
      'circle-color': '#ffffff',
    },
  },
  {
    id: 'gl-draw-point-inner',
    type: 'circle',
    filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'feature']],
    paint: {
      'circle-radius': ['case', ['==', ['get', 'active'], 'true'], 6, 4],
      'circle-color': ['case', ['==', ['get', 'active'], 'true'], DRAW_ACTIVE_COLOR, DRAW_COLOR],
    },
  },
  {
    id: 'gl-draw-vertex-outer',
    type: 'circle',
    filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'vertex'], ['!=', 'mode', 'simple_select']],
    paint: {
      'circle-radius': ['case', ['==', ['get', 'active'], 'true'], 8, 6],
      'circle-color': '#ffffff',
    },
  },
  {
    id: 'gl-draw-vertex-inner',
    type: 'circle',
    filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'vertex'], ['!=', 'mode', 'simple_select']],
    paint: {
      'circle-radius': ['case', ['==', ['get', 'active'], 'true'], 6, 4],
      'circle-color': DRAW_ACTIVE_COLOR,
    },
  },
  {
    id: 'gl-draw-midpoint',
    type: 'circle',
    filter: ['all', ['==', 'meta', 'midpoint']],
    paint: { 'circle-radius': 4, 'circle-color': DRAW_ACTIVE_COLOR },
  },
];

export interface UseMapDrawingOptions {
  map: maplibregl.Map | null;
  loaded: boolean;
  drawRef: MutableRefObject<MapboxDraw | null>;
  circleMarkerRef: MutableRefObject<maplibregl.Marker | null>;
  geofence: GeofencesAdmin;
  equipment: EquipmentAdmin;
}

// Coordinador del unico punto de acoplamiento real entre Geocercas y Equipo estatico: un solo
// mapa, una sola instancia de MapboxDraw, y un solo listener de click que decide entre "coloco
// equipo" o "fijo centro de circulo de geocerca" segun cual panel este activo - por eso vive
// aparte de los dos hooks de recurso (useGeofencesAdmin/useEquipmentAdmin), que por lo demas son
// independientes entre si.
export function useMapDrawing({
  map,
  loaded,
  drawRef,
  circleMarkerRef,
  geofence,
  equipment,
}: UseMapDrawingOptions) {
  useEffect(() => {
    if (!map || !loaded || drawRef.current) return;

    const draw = new MapboxDraw({ displayControlsDefault: false, controls: {}, styles: DRAW_STYLES });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    map.addControl(draw as any);
    drawRef.current = draw;
    geofence.ensureDraftPreviewLayer(map);
    equipment.ensureEquipmentDraftLayer(map);

    const handleClick = (e: maplibregl.MapMouseEvent) => {
      const lat = e.lngLat.lat;
      const lon = e.lngLat.lng;

      if (equipment.placingEquipmentRef.current) {
        equipment.setEquipmentPosition({ lat, lon });
        equipment.setPlacingEquipment(false);
        equipment.placeEquipmentMarker(lat, lon);
        return;
      }

      if (!geofence.showGeoPanelRef.current || geofence.geoShapeRef.current !== 'circle') return;
      geofence.setGeoSelectedCenter({ lat, lon });
      if (circleMarkerRef.current) circleMarkerRef.current.remove();
      circleMarkerRef.current = new maplibregl.Marker().setLngLat(e.lngLat).addTo(map);
    };
    map.on('click', handleClick);

    const handleDrawChange = () => geofence.updateDraftPreviewRef.current();
    map.on('draw.render', handleDrawChange);
    map.on('draw.update', handleDrawChange);

    const handleDrawCreate = (e: { features?: { id?: string | number }[] }) => {
      geofence.updateDraftPreviewRef.current();
      const featureId = e.features?.[0]?.id;
      if (featureId != null) {
        // changeMode síncrono aquí reentra draw.create y truena el stack - diferir
        setTimeout(() => {
          drawRef.current?.changeMode('direct_select', { featureId: String(featureId) });
        }, 0);
      }
    };
    map.on('draw.create', handleDrawCreate);

    return () => {
      map.off('click', handleClick);
      map.off('draw.render', handleDrawChange);
      map.off('draw.update', handleDrawChange);
      map.off('draw.create', handleDrawCreate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, loaded]);
}
