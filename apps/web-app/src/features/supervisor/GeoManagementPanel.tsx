import { createApiClient, getStoredToken } from '@gaga-gps/client';
import {
  circleToPolygon,
  EQUIPMENT_CORE_COLOR,
  EQUIPMENT_OUTER_COLOR,
  lineToBufferPolygon,
} from '@gaga-gps/map-core';
import { Modal } from '@gaga-gps/ui';
import type { Geofence } from '@gaga-gps/shared-types';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import type { Feature, FeatureCollection, LineString } from 'geojson';
import maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

const api = createApiClient({ getToken: getStoredToken });

type GeofenceShape = 'circle' | 'polygon' | 'polyline';
export type ManageOverlay = 'geofences' | 'equipment' | 'maps' | null;

const SHAPE_HINTS: Record<GeofenceShape, string> = {
  circle: 'Clic en el mapa para fijar el centro.',
  polygon:
    'Dibuje el polígono en el mapa (clic para cada vértice, doble clic para terminar antes de presionar Crear).',
  polyline:
    'Dibuje la ruta en el mapa (clic para cada punto, doble clic para terminar antes de presionar Crear).',
};

const MAP_STATUS_LABEL: Record<string, string> = {
  processing: 'Procesando…',
  ready: 'Listo',
  failed: 'Error',
};

const CRS_OPTIONS = [
  { value: 'EPSG:32611', label: 'UTM zona 11N (EPSG:32611)' },
  { value: 'EPSG:32612', label: 'UTM zona 12N (EPSG:32612)' },
  { value: 'EPSG:32613', label: 'UTM zona 13N (EPSG:32613)' },
  { value: 'EPSG:32614', label: 'UTM zona 14N (EPSG:32614)' },
  { value: 'EPSG:32615', label: 'UTM zona 15N (EPSG:32615)' },
  { value: 'EPSG:32616', label: 'UTM zona 16N (EPSG:32616)' },
  { value: 'EPSG:4326', label: 'WGS84 lat/lon (EPSG:4326)' },
];

const DRAW_COLOR = '#a855f7';
const DRAW_ACTIVE_COLOR = '#e879f9';
const PREVIEW_COLOR = DRAW_COLOR;
const PREVIEW_SOURCE_ID = 'sup-geofence-draft-preview';
const EQUIP_PREVIEW_SOURCE_ID = 'sup-equipment-draft-preview';
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
    filter: [
      'all',
      ['==', '$type', 'Point'],
      ['==', 'meta', 'vertex'],
      ['!=', 'mode', 'simple_select'],
    ],
    paint: {
      'circle-radius': ['case', ['==', ['get', 'active'], 'true'], 8, 6],
      'circle-color': '#ffffff',
    },
  },
  {
    id: 'gl-draw-vertex-inner',
    type: 'circle',
    filter: [
      'all',
      ['==', '$type', 'Point'],
      ['==', 'meta', 'vertex'],
      ['!=', 'mode', 'simple_select'],
    ],
    paint: {
      'circle-radius': ['case', ['==', ['get', 'active'], 'true'], 6, 4],
      'circle-color': DRAW_ACTIVE_COLOR,
    },
  },
  {
    id: 'gl-draw-midpoint',
    type: 'circle',
    filter: ['all', ['==', 'meta', 'midpoint']],
    paint: {
      'circle-radius': 4,
      'circle-color': DRAW_ACTIVE_COLOR,
    },
  },
];

interface GeofenceFormState {
  name: string;
  type: string;
  radius: string;
  corridorWidth: string;
  corridorMargin: string;
}

interface EquipmentFormState {
  name: string;
  type: string;
  swingRadius: string;
  safetyRadius: string;
  linkedDeviceId: string;
}

interface DeviceRow {
  id: number;
  unique_id: string;
  name: string;
  project_id: number | null;
}

interface EquipmentRow {
  id: number;
  name: string;
  type: string;
  latitude: number;
  longitude: number;
  swing_radius: number;
  safety_radius: number;
  status: 'active_swing' | 'active_pause' | 'inactive';
  linked_device_id: string | null;
}

type MapStatus = 'processing' | 'ready' | 'failed';

interface MapRow {
  id: number;
  name: string;
  status: MapStatus;
  active: boolean;
  error_message: string | null;
}

export interface GeoManagementPanelHandle {
  open(overlay: Exclude<ManageOverlay, null>): void;
}

export interface GeoManagementPanelProps {
  map: maplibregl.Map | null;
  geofences: Geofence[];
}

export const GeoManagementPanel = forwardRef<GeoManagementPanelHandle, GeoManagementPanelProps>(
  function GeoManagementPanel({ map, geofences }, ref) {
    const [activeOverlay, setActiveOverlay] = useState<ManageOverlay>(null);
    useImperativeHandle(ref, () => ({ open: (overlay) => setActiveOverlay(overlay) }), []);

    const [allDevices, setAllDevices] = useState<DeviceRow[]>([]);
    const [allEquipment, setAllEquipment] = useState<EquipmentRow[]>([]);
    const [mapsRows, setMapsRows] = useState<MapRow[]>([]);
    const mapsPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    async function loadDevices() {
      setAllDevices(await api.get<DeviceRow[]>('/api/devices'));
    }
    async function loadEquipment() {
      setAllEquipment(await api.get<EquipmentRow[]>('/api/equipment'));
    }
    async function loadMaps() {
      const data = await api.get<MapRow[]>('/api/maps');
      setMapsRows(data);
      const stillProcessing = data.some((m) => m.status === 'processing');
      if (stillProcessing && !mapsPollRef.current) {
        mapsPollRef.current = setInterval(loadMaps, 3000);
      } else if (!stillProcessing && mapsPollRef.current) {
        clearInterval(mapsPollRef.current);
        mapsPollRef.current = null;
      }
    }

    useEffect(() => {
      loadDevices();
      loadEquipment();
      loadMaps();
      return () => {
        if (mapsPollRef.current) clearInterval(mapsPollRef.current);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- carga única al montar
    }, []);

    const drawRef = useRef<MapboxDraw | null>(null);
    const circleMarkerRef = useRef<maplibregl.Marker | null>(null);
    const equipmentMarkerRef = useRef<maplibregl.Marker | null>(null);

    const [showGeoPanel, setShowGeoPanel] = useState(false);
    const [geoShape, setGeoShape] = useState<GeofenceShape>('circle');
    const [geoSelectedCenter, setGeoSelectedCenter] = useState<{ lat: number; lon: number } | null>(
      null,
    );
    const [geoEditingId, setGeoEditingId] = useState<number | null>(null);
    const [geofenceForm, setGeofenceForm] = useState<GeofenceFormState>({
      name: '',
      type: 'warning',
      radius: '',
      corridorWidth: '',
      corridorMargin: '',
    });

    const [showEquipPanel, setShowEquipPanel] = useState(false);
    const [placingEquipment, setPlacingEquipment] = useState(false);
    const [equipmentEditingId, setEquipmentEditingId] = useState<number | null>(null);
    const [equipmentPosition, setEquipmentPosition] = useState<{ lat: number; lon: number } | null>(
      null,
    );
    const [equipmentForm, setEquipmentForm] = useState<EquipmentFormState>({
      name: '',
      type: '',
      swingRadius: '',
      safetyRadius: '',
      linkedDeviceId: '',
    });
    const linkableDevices = allDevices.filter(
      (d) =>
        !allEquipment.some(
          (eq) => eq.linked_device_id === d.unique_id && eq.id !== equipmentEditingId,
        ),
    );

    const [mapImportModal, setMapImportModal] = useState(false);
    const [mapImportForm, setMapImportForm] = useState({ name: '', crs: 'EPSG:32613' });
    const [mapImportError, setMapImportError] = useState('');
    const imageInputRef = useRef<HTMLInputElement>(null);
    const worldInputRef = useRef<HTMLInputElement>(null);

    const geoShapeRef = useRef(geoShape);
    geoShapeRef.current = geoShape;
    const showGeoPanelRef = useRef(showGeoPanel);
    showGeoPanelRef.current = showGeoPanel;
    const placingEquipmentRef = useRef(placingEquipment);
    placingEquipmentRef.current = placingEquipment;

    function ensureDraftPreviewLayer(m: maplibregl.Map) {
      if (m.getSource(PREVIEW_SOURCE_ID)) return;
      const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
      m.addSource(PREVIEW_SOURCE_ID, { type: 'geojson', data: empty });
      m.addLayer({
        id: `${PREVIEW_SOURCE_ID}-fill`,
        type: 'fill',
        source: PREVIEW_SOURCE_ID,
        paint: {
          'fill-color': PREVIEW_COLOR,
          'fill-opacity': ['case', ['==', ['get', 'ring'], 'margin'], 0.12, 0.3],
        },
      });
      m.addLayer({
        id: `${PREVIEW_SOURCE_ID}-line`,
        type: 'line',
        source: PREVIEW_SOURCE_ID,
        paint: {
          'line-color': PREVIEW_COLOR,
          'line-width': 3,
          'line-dasharray': [2, 1],
        },
      });
    }

    function ensureEquipmentDraftLayer(m: maplibregl.Map) {
      if (m.getSource(EQUIP_PREVIEW_SOURCE_ID)) return;
      const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
      m.addSource(EQUIP_PREVIEW_SOURCE_ID, { type: 'geojson', data: empty });
      m.addLayer({
        id: `${EQUIP_PREVIEW_SOURCE_ID}-outer-fill`,
        type: 'fill',
        source: EQUIP_PREVIEW_SOURCE_ID,
        filter: ['==', ['get', 'ring'], 'safety'],
        paint: { 'fill-color': EQUIPMENT_OUTER_COLOR, 'fill-opacity': 0.12 },
      });
      m.addLayer({
        id: `${EQUIP_PREVIEW_SOURCE_ID}-outer-line`,
        type: 'line',
        source: EQUIP_PREVIEW_SOURCE_ID,
        filter: ['==', ['get', 'ring'], 'safety'],
        paint: { 'line-color': EQUIPMENT_OUTER_COLOR, 'line-width': 2, 'line-dasharray': [2, 1] },
      });
      m.addLayer({
        id: `${EQUIP_PREVIEW_SOURCE_ID}-core-fill`,
        type: 'fill',
        source: EQUIP_PREVIEW_SOURCE_ID,
        filter: ['==', ['get', 'ring'], 'swing'],
        paint: { 'fill-color': EQUIPMENT_CORE_COLOR, 'fill-opacity': 0.35 },
      });
      m.addLayer({
        id: `${EQUIP_PREVIEW_SOURCE_ID}-core-line`,
        type: 'line',
        source: EQUIP_PREVIEW_SOURCE_ID,
        filter: ['==', ['get', 'ring'], 'swing'],
        paint: { 'line-color': EQUIPMENT_CORE_COLOR, 'line-width': 2 },
      });
    }

    useEffect(() => {
      if (!map) return;
      const source = map.getSource(EQUIP_PREVIEW_SOURCE_ID) as GeoJSONSource | undefined;
      if (!source) return;
      const features: Feature[] = [];
      if (showEquipPanel && equipmentPosition) {
        const swingRadius = parseFloat(equipmentForm.swingRadius);
        const safetyRadius = parseFloat(equipmentForm.safetyRadius);
        if (safetyRadius > 0) {
          features.push({
            type: 'Feature',
            properties: { ring: 'safety' },
            geometry: circleToPolygon(equipmentPosition.lat, equipmentPosition.lon, safetyRadius),
          });
        }
        if (swingRadius > 0) {
          features.push({
            type: 'Feature',
            properties: { ring: 'swing' },
            geometry: circleToPolygon(equipmentPosition.lat, equipmentPosition.lon, swingRadius),
          });
        }
      }
      source.setData({ type: 'FeatureCollection', features });
    }, [map, showEquipPanel, equipmentPosition, equipmentForm.swingRadius, equipmentForm.safetyRadius]);

    function clearEquipmentDraftPreview() {
      if (!map) return;
      const source = map.getSource(EQUIP_PREVIEW_SOURCE_ID) as GeoJSONSource | undefined;
      source?.setData({ type: 'FeatureCollection', features: [] });
    }

    const updateDraftPreviewRef = useRef<() => void>(() => {});

    function updateDraftPreview() {
      if (!map) return;
      const source = map.getSource(PREVIEW_SOURCE_ID) as GeoJSONSource | undefined;
      if (!source) return;
      const features: Feature[] = [];

      if (showGeoPanelRef.current && geoShapeRef.current === 'circle' && geoSelectedCenter) {
        const radiusMeters = parseFloat(geofenceForm.radius);
        if (radiusMeters > 0) {
          features.push({
            type: 'Feature',
            properties: { ring: 'core' },
            geometry: circleToPolygon(geoSelectedCenter.lat, geoSelectedCenter.lon, radiusMeters),
          });
        }
      } else if (showGeoPanelRef.current && geoShapeRef.current === 'polyline') {
        const line = drawRef.current
          ?.getAll()
          .features.find((f) => f.geometry.type === 'LineString') as
          | (Feature & { geometry: LineString })
          | undefined;
        const widthMeters = parseFloat(geofenceForm.corridorWidth);
        const marginMeters = parseFloat(geofenceForm.corridorMargin);
        if (line && widthMeters > 0) {
          if (marginMeters > 0) {
            features.push({
              type: 'Feature',
              properties: { ring: 'margin' },
              geometry: lineToBufferPolygon(line.geometry, widthMeters + marginMeters),
            });
          }
          features.push({
            type: 'Feature',
            properties: { ring: 'core' },
            geometry: lineToBufferPolygon(line.geometry, widthMeters),
          });
        }
      }

      const geojson: FeatureCollection = { type: 'FeatureCollection', features };
      source.setData(geojson);
    }
    updateDraftPreviewRef.current = updateDraftPreview;

    useEffect(() => {
      updateDraftPreviewRef.current();
    }, [showGeoPanel, geoShape, geoSelectedCenter, geofenceForm.radius, geofenceForm.corridorWidth, geofenceForm.corridorMargin]);

    useEffect(() => {
      if (!map || drawRef.current) return;

      const draw = new MapboxDraw({ displayControlsDefault: false, controls: {}, styles: DRAW_STYLES });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- maplibregl y mapbox-gl-draw difieren levemente en sus tipos de Map, pero son compatibles en tiempo de ejecución
      map.addControl(draw as any);
      drawRef.current = draw;
      ensureDraftPreviewLayer(map);
      ensureEquipmentDraftLayer(map);

      const handleClick = (e: maplibregl.MapMouseEvent) => {
        const lat = e.lngLat.lat;
        const lon = e.lngLat.lng;

        if (placingEquipmentRef.current) {
          setEquipmentPosition({ lat, lon });
          setPlacingEquipment(false);
          placeEquipmentMarker(lat, lon);
          return;
        }

        if (!showGeoPanelRef.current || geoShapeRef.current !== 'circle') return;
        setGeoSelectedCenter({ lat, lon });
        if (circleMarkerRef.current) circleMarkerRef.current.remove();
        circleMarkerRef.current = new maplibregl.Marker().setLngLat(e.lngLat).addTo(map);
      };
      map.on('click', handleClick);

      const handleDrawChange = () => updateDraftPreviewRef.current();
      map.on('draw.render', handleDrawChange);
      map.on('draw.update', handleDrawChange);

      const handleDrawCreate = (e: { features?: { id?: string | number }[] }) => {
        updateDraftPreviewRef.current();
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
    }, [map]);

    function clearDraftPreview() {
      if (!map) return;
      const source = map.getSource(PREVIEW_SOURCE_ID) as GeoJSONSource | undefined;
      source?.setData({ type: 'FeatureCollection', features: [] });
    }

    function onShapeChange(next: GeofenceShape) {
      setGeoShape(next);
      drawRef.current?.deleteAll();
      clearDraftPreview();
      if (next === 'polygon') drawRef.current?.changeMode('draw_polygon');
      else if (next === 'polyline') drawRef.current?.changeMode('draw_line_string');
    }

    function cancelDrawing() {
      drawRef.current?.deleteAll();
      clearDraftPreview();
      if (geoShape === 'polygon') drawRef.current?.changeMode('draw_polygon');
      else if (geoShape === 'polyline') drawRef.current?.changeMode('draw_line_string');
    }

    function finishDrawing() {
      drawRef.current?.changeMode('simple_select');
    }

    function resetGeofenceForm() {
      setGeoEditingId(null);
      setGeofenceForm({ name: '', type: 'warning', radius: '', corridorWidth: '', corridorMargin: '' });
      setGeoSelectedCenter(null);
      if (circleMarkerRef.current) {
        circleMarkerRef.current.remove();
        circleMarkerRef.current = null;
      }
      drawRef.current?.deleteAll();
      clearDraftPreview();
    }

    function closeGeoPanel() {
      resetGeofenceForm();
      setShowGeoPanel(false);
    }

    function openCreateGeofence() {
      setActiveOverlay(null);
      setShowGeoPanel(true);
    }

    function editGeofenceRow(g: Geofence) {
      if (!map) return;
      setActiveOverlay(null);
      setShowGeoPanel(true);
      setGeoEditingId(g.id);
      setGeoShape(g.shapeType);
      setGeofenceForm({
        name: g.name,
        type: g.type,
        radius: g.shapeType === 'circle' ? String(g.radiusMeters) : '',
        corridorWidth: g.shapeType === 'polyline' ? String(g.corridorWidthMeters) : '',
        corridorMargin:
          g.shapeType === 'polyline' && g.corridorDangerMarginMeters != null
            ? String(g.corridorDangerMarginMeters)
            : '',
      });
      drawRef.current?.deleteAll();
      if (g.shapeType === 'circle') {
        setGeoSelectedCenter({ lat: g.center.lat, lon: g.center.lon });
        if (circleMarkerRef.current) circleMarkerRef.current.remove();
        circleMarkerRef.current = new maplibregl.Marker()
          .setLngLat([g.center.lon, g.center.lat])
          .addTo(map);
        map.flyTo({ center: [g.center.lon, g.center.lat], zoom: 15 });
      } else {
        const addedIds = drawRef.current?.add({ type: 'Feature', properties: {}, geometry: g.geometry });
        const featureId = addedIds?.[0];
        if (featureId != null) {
          drawRef.current?.changeMode('direct_select', { featureId: String(featureId) });
        }
        const coords = g.geometry.type === 'Polygon' ? g.geometry.coordinates[0] : g.geometry.coordinates;
        if (coords.length > 0) {
          const bounds = coords.reduce(
            (b, c) => b.extend(c as [number, number]),
            new maplibregl.LngLatBounds(coords[0] as [number, number], coords[0] as [number, number]),
          );
          map.fitBounds(bounds, { padding: 80, maxZoom: 17 });
        }
      }
    }

    async function saveGeofenceRow() {
      const isEditing = geoEditingId != null;
      const method = isEditing ? 'patch' : 'post';
      const url = isEditing ? `/api/geofences/${geoEditingId}` : '/api/geofences';

      try {
        if (geoShape === 'circle') {
          const radiusMeters = parseFloat(geofenceForm.radius);
          if (!geofenceForm.name || !geoSelectedCenter || !radiusMeters) {
            alert('Complete nombre, centro (clic en mapa) y radio');
            return;
          }
          await api[method](url, {
            name: geofenceForm.name,
            type: geofenceForm.type,
            shapeType: 'circle',
            centerLat: geoSelectedCenter.lat,
            centerLon: geoSelectedCenter.lon,
            radiusMeters,
          });
        } else {
          const mode = drawRef.current?.getMode();
          if (!isEditing && (mode === 'draw_polygon' || mode === 'draw_line_string')) {
            alert('Termine el dibujo con doble clic en el último punto antes de guardar');
            return;
          }
          const drawn = drawRef.current?.getAll();
          if (!drawn?.features.length) {
            alert('Dibuje la forma en el mapa antes de guardar');
            return;
          }
          const geometry = drawn.features[0].geometry;

          if (geoShape === 'polygon') {
            if (!geofenceForm.name) {
              alert('Complete el nombre');
              return;
            }
            await api[method](url, {
              name: geofenceForm.name,
              type: geofenceForm.type,
              shapeType: 'polygon',
              geometry,
            });
          } else {
            const corridorWidthMeters = parseFloat(geofenceForm.corridorWidth);
            const corridorDangerMarginMeters = parseFloat(geofenceForm.corridorMargin) || null;
            if (!geofenceForm.name || !corridorWidthMeters) {
              alert('Complete nombre y ancho seguro del corredor');
              return;
            }
            await api[method](url, {
              name: geofenceForm.name,
              type: geofenceForm.type,
              shapeType: 'polyline',
              geometry,
              corridorWidthMeters,
              corridorDangerMarginMeters,
            });
          }
        }
        resetGeofenceForm();
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Error guardando la geocerca');
      }
    }

    async function deleteGeofenceRow(g: Geofence) {
      const typed = prompt(
        `Esta acción no se puede deshacer. Se dejará de evaluar esta zona/corredor en tiempo real ` +
          `para todos los vehículos del proyecto de inmediato. Para eliminar "${g.name}", escriba exactamente su nombre:`,
      );
      if (typed === null) return;
      if (typed !== g.name) {
        alert('El nombre no coincide - no se eliminó la geocerca');
        return;
      }
      try {
        await api.delete(`/api/geofences/${g.id}`);
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Error eliminando la geocerca');
      }
    }

    function placeEquipmentMarker(lat: number, lon: number) {
      if (!map) return;
      if (equipmentMarkerRef.current) equipmentMarkerRef.current.remove();
      const marker = new maplibregl.Marker({ color: EQUIPMENT_CORE_COLOR, draggable: true })
        .setLngLat([lon, lat])
        .addTo(map);
      marker.on('dragend', () => {
        const lngLat = marker.getLngLat();
        setEquipmentPosition({ lat: lngLat.lat, lon: lngLat.lng });
      });
      equipmentMarkerRef.current = marker;
    }

    function resetEquipmentForm() {
      setEquipmentEditingId(null);
      setEquipmentForm({ name: '', type: '', swingRadius: '', safetyRadius: '', linkedDeviceId: '' });
      setEquipmentPosition(null);
      setPlacingEquipment(false);
      clearEquipmentDraftPreview();
      if (equipmentMarkerRef.current) {
        equipmentMarkerRef.current.remove();
        equipmentMarkerRef.current = null;
      }
    }

    function closeEquipPanel() {
      resetEquipmentForm();
      setShowEquipPanel(false);
    }

    function openCreateEquipment() {
      setActiveOverlay(null);
      setShowEquipPanel(true);
    }

    function editEquipmentRow(eq: EquipmentRow) {
      if (!map) return;
      setActiveOverlay(null);
      setShowEquipPanel(true);
      setEquipmentEditingId(eq.id);
      setEquipmentForm({
        name: eq.name,
        type: eq.type,
        swingRadius: String(eq.swing_radius),
        safetyRadius: String(eq.safety_radius),
        linkedDeviceId: eq.linked_device_id ?? '',
      });
      setEquipmentPosition({ lat: eq.latitude, lon: eq.longitude });
      placeEquipmentMarker(eq.latitude, eq.longitude);
      map.flyTo({ center: [eq.longitude, eq.latitude], zoom: 16 });
    }

    async function saveEquipmentRow() {
      const isEditing = equipmentEditingId != null;
      const swingRadius = parseFloat(equipmentForm.swingRadius);
      const safetyRadius = parseFloat(equipmentForm.safetyRadius);
      if (!equipmentForm.name || !equipmentForm.type || !equipmentPosition || !swingRadius || !safetyRadius) {
        alert('Complete nombre, tipo, posición (clic en el mapa o arrastre el marcador) y ambos radios');
        return;
      }
      try {
        const payload = {
          name: equipmentForm.name,
          type: equipmentForm.type,
          latitude: equipmentPosition.lat,
          longitude: equipmentPosition.lon,
          swingRadius,
          safetyRadius,
          linkedDeviceId: equipmentForm.linkedDeviceId || null,
        };
        if (isEditing) {
          await api.patch(`/api/equipment/${equipmentEditingId}`, payload);
        } else {
          await api.post('/api/equipment', payload);
        }
        resetEquipmentForm();
        loadEquipment();
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Error guardando el equipo');
      }
    }

    async function deleteEquipmentRow(eq: EquipmentRow) {
      const linkedNote = eq.linked_device_id
        ? ` La tableta vinculada (${eq.linked_device_id}) NO se elimina - solo queda sin equipo asignado.`
        : '';
      const typed = prompt(
        `Esta acción no se puede deshacer. Se eliminarán las alertas de aproximación activas contra ` +
          `este equipo.${linkedNote} Para eliminar "${eq.name}", escriba exactamente su nombre:`,
      );
      if (typed === null) return;
      if (typed !== eq.name) {
        alert('El nombre no coincide - no se eliminó el equipo');
        return;
      }
      try {
        await api.delete(`/api/equipment/${eq.id}`);
        loadEquipment();
        if (eq.linked_device_id) loadDevices();
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Error eliminando el equipo');
      }
    }

    async function importMap() {
      setMapImportError('');
      const imageFile = imageInputRef.current?.files?.[0];
      const worldFile = worldInputRef.current?.files?.[0];
      if (!mapImportForm.name.trim() || !imageFile || !worldFile) {
        setMapImportError('Completa nombre, imagen y world file');
        return;
      }
      const formData = new FormData();
      formData.append('name', mapImportForm.name.trim());
      formData.append('sourceCrs', mapImportForm.crs);
      formData.append('image', imageFile);
      formData.append('worldFile', worldFile);

      try {
        const token = getStoredToken();
        const res = await fetch('/api/maps', {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: formData,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Error ${res.status}`);
        }
        setMapImportForm({ name: '', crs: 'EPSG:32613' });
        if (imageInputRef.current) imageInputRef.current.value = '';
        if (worldInputRef.current) worldInputRef.current.value = '';
        setMapImportModal(false);
        loadMaps();
      } catch (err) {
        setMapImportError(err instanceof Error ? err.message : 'Error importando el mapa');
      }
    }

    async function activateMap(id: number) {
      if (!confirm('¿Activar este mapa? Se sumará como capa visible de inmediato.')) return;
      await api.post(`/api/maps/${id}/activate`);
      loadMaps();
    }

    async function deactivateMap(id: number) {
      if (!confirm('¿Desactivar este mapa? Dejará de verse en el mapa.')) return;
      await api.post(`/api/maps/${id}/deactivate`);
      loadMaps();
    }

    async function renameMap(id: number, currentName: string) {
      const name = prompt('Nuevo nombre:', currentName);
      if (!name) return;
      await api.patch(`/api/maps/${id}`, { name });
      loadMaps();
    }

    async function deleteMapRow(m: MapRow) {
      const typed = prompt(
        `Esta acción no se puede deshacer. Se eliminará también el archivo .mbtiles generado y las ` +
          `imágenes originales subidas para procesarlo${m.active ? ' (primero hay que desactivarlo)' : ''}. ` +
          `Para eliminar "${m.name}", escriba exactamente su nombre:`,
      );
      if (typed === null) return;
      if (typed !== m.name) {
        alert('El nombre no coincide - no se eliminó el mapa');
        return;
      }
      try {
        await api.delete(`/api/maps/${m.id}`);
        loadMaps();
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Error eliminando el mapa');
      }
    }

    return (
      <>
        {showGeoPanel && (
          <div className="sup-float-panel sup-glass">
            <div className="sup-float-panel-header">
              <h4>{geoEditingId != null ? 'Editar geocerca' : 'Nueva geocerca'}</h4>
              <button className="gg-modal-close" onClick={closeGeoPanel} aria-label="Cerrar">
                X
              </button>
            </div>
            <div className="sup-float-panel-body">
              <div className="sup-field-group">
                <span className="sup-field-group-title">Forma</span>
                <select
                  value={geoShape}
                  onChange={(e) => onShapeChange(e.target.value as GeofenceShape)}
                  disabled={geoEditingId != null}
                >
                  <option value="circle">Círculo</option>
                  <option value="polygon">Polígono (zona autorizada)</option>
                  <option value="polyline">Ruta / corredor autorizado</option>
                </select>
                <span className="sup-hint">{SHAPE_HINTS[geoShape]}</span>
              </div>

              <div className="sup-field-group">
                <span className="sup-field-group-title">Datos</span>
                <input
                  placeholder="Nombre"
                  value={geofenceForm.name}
                  onChange={(e) => setGeofenceForm({ ...geofenceForm, name: e.target.value })}
                />
                <select
                  value={geofenceForm.type}
                  onChange={(e) => setGeofenceForm({ ...geofenceForm, type: e.target.value })}
                >
                  <option value="warning">Advertencia (amarillo)</option>
                  <option value="danger">Peligro (rojo)</option>
                  <option value="parking">Estacionamiento (azul)</option>
                </select>
              </div>

              {geoShape === 'circle' && (
                <div className="sup-field-group">
                  <span className="sup-field-group-title">Ubicación y radio</span>
                  <input placeholder="Lat" readOnly value={geoSelectedCenter ? geoSelectedCenter.lat.toFixed(6) : ''} />
                  <input placeholder="Lon" readOnly value={geoSelectedCenter ? geoSelectedCenter.lon.toFixed(6) : ''} />
                  <input
                    placeholder="Radio (m)"
                    type="number"
                    value={geofenceForm.radius}
                    onChange={(e) => setGeofenceForm({ ...geofenceForm, radius: e.target.value })}
                  />
                  {geoSelectedCenter && (
                    <span className="sup-hint">Vista previa en morado sobre el mapa - se actualiza mientras escribes.</span>
                  )}
                </div>
              )}
              {geoShape === 'polyline' && (
                <div className="sup-field-group">
                  <span className="sup-field-group-title">Ancho del corredor</span>
                  <input
                    placeholder="Ancho seguro (m)"
                    type="number"
                    value={geofenceForm.corridorWidth}
                    onChange={(e) => setGeofenceForm({ ...geofenceForm, corridorWidth: e.target.value })}
                  />
                  <input
                    placeholder="Margen advertencia (m)"
                    type="number"
                    value={geofenceForm.corridorMargin}
                    onChange={(e) => setGeofenceForm({ ...geofenceForm, corridorMargin: e.target.value })}
                  />
                  <span className="sup-hint">
                    Vista previa en morado sobre el mapa (franja segura + margen) - se actualiza mientras escribes o mueves un
                    vértice.
                  </span>
                </div>
              )}
              <div className="sup-float-panel-actions">
                <button className="btn btn-sm" onClick={saveGeofenceRow}>
                  {geoEditingId != null ? 'Guardar cambios' : 'Crear'}
                </button>
                {geoShape !== 'circle' && geoEditingId == null && (
                  <>
                    <button className="btn btn-sm" onClick={finishDrawing}>
                      Finalizar trazado
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={cancelDrawing}>
                      Cancelar dibujo
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {showEquipPanel && (
          <div className="sup-float-panel sup-glass">
            <div className="sup-float-panel-header">
              <h4>{equipmentEditingId != null ? 'Editar equipo estático' : 'Nuevo equipo estático'}</h4>
              <button className="gg-modal-close" onClick={closeEquipPanel} aria-label="Cerrar">
                X
              </button>
            </div>
            <div className="sup-float-panel-body">
              <div className="sup-field-group">
                <span className="sup-field-group-title">Datos</span>
                <input
                  placeholder="Nombre"
                  value={equipmentForm.name}
                  onChange={(e) => setEquipmentForm({ ...equipmentForm, name: e.target.value })}
                />
                <input
                  placeholder="Tipo (pala/excavadora)"
                  value={equipmentForm.type}
                  onChange={(e) => setEquipmentForm({ ...equipmentForm, type: e.target.value })}
                />
              </div>

              <div className="sup-field-group">
                <span className="sup-field-group-title">Dispositivo vinculado</span>
                <select
                  value={equipmentForm.linkedDeviceId}
                  onChange={(e) => setEquipmentForm({ ...equipmentForm, linkedDeviceId: e.target.value })}
                >
                  <option value="">Sin vincular</option>
                  {linkableDevices.map((d) => (
                    <option key={d.unique_id} value={d.unique_id}>
                      {d.name} ({d.unique_id})
                    </option>
                  ))}
                </select>
              </div>

              <div className="sup-field-group">
                <span className="sup-field-group-title">Ubicación y radios</span>
                <button
                  className={`btn btn-sm${placingEquipment ? ' active' : ''}`}
                  onClick={() => setPlacingEquipment((v) => !v)}
                >
                  {placingEquipment ? 'Clic en el mapa…' : equipmentPosition ? 'Reubicar (clic en el mapa)' : 'Colocar en mapa'}
                </button>
                <input placeholder="Lat" readOnly value={equipmentPosition ? equipmentPosition.lat.toFixed(6) : ''} />
                <input placeholder="Lon" readOnly value={equipmentPosition ? equipmentPosition.lon.toFixed(6) : ''} />
                <input
                  placeholder="Radio de giro (m)"
                  type="number"
                  value={equipmentForm.swingRadius}
                  onChange={(e) => setEquipmentForm({ ...equipmentForm, swingRadius: e.target.value })}
                />
                <input
                  placeholder="Radio seguridad (m)"
                  type="number"
                  value={equipmentForm.safetyRadius}
                  onChange={(e) => setEquipmentForm({ ...equipmentForm, safetyRadius: e.target.value })}
                />
              </div>

              <div className="sup-float-panel-actions">
                <button className="btn btn-sm" onClick={saveEquipmentRow}>
                  {equipmentEditingId != null ? 'Guardar cambios' : 'Agregar'}
                </button>
              </div>
            </div>
          </div>
        )}

        <Modal size="large" open={activeOverlay === 'geofences'} title="Geocercas" onClose={() => setActiveOverlay(null)}>
          <div className="sup-overlay-toolbar">
            <button className="btn btn-sm" onClick={openCreateGeofence}>
              + Nueva geocerca
            </button>
          </div>
          {geofences.length === 0 ? (
            <div className="sup-org-empty">Sin geocercas todavía.</div>
          ) : (
            <table className="sup-manage-table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Tipo</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {geofences.map((g) => (
                  <tr key={g.id}>
                    <td>{g.name}</td>
                    <td>{g.type}</td>
                    <td className="sup-org-row-actions">
                      <button className="btn btn-sm" onClick={() => editGeofenceRow(g)}>
                        Editar
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => deleteGeofenceRow(g)}>
                        Eliminar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>

        <Modal size="large" open={activeOverlay === 'equipment'} title="Equipo estático" onClose={() => setActiveOverlay(null)}>
          <div className="sup-overlay-toolbar">
            <button className="btn btn-sm" onClick={openCreateEquipment}>
              + Nuevo equipo
            </button>
          </div>
          {allEquipment.length === 0 ? (
            <div className="sup-org-empty">Sin equipo estático todavía.</div>
          ) : (
            <table className="sup-manage-table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Tipo</th>
                  <th>Radio giro</th>
                  <th>Radio seguridad</th>
                  <th>Dispositivo</th>
                  <th>Estado</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {allEquipment.map((eq) => (
                  <tr key={eq.id}>
                    <td>{eq.name}</td>
                    <td>{eq.type}</td>
                    <td>{eq.swing_radius}</td>
                    <td>{eq.safety_radius}</td>
                    <td>
                      {eq.linked_device_id
                        ? (allDevices.find((d) => d.unique_id === eq.linked_device_id)?.name ?? eq.linked_device_id)
                        : '-'}
                    </td>
                    <td>{eq.linked_device_id ? (eq.status === 'inactive' ? 'Inactivo (sin turno)' : 'En operación') : eq.status}</td>
                    <td className="sup-org-row-actions">
                      <button className="btn btn-sm" onClick={() => editEquipmentRow(eq)}>
                        Editar
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => deleteEquipmentRow(eq)}>
                        Eliminar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>

        <Modal size="large" open={activeOverlay === 'maps'} title="Mapas" onClose={() => setActiveOverlay(null)}>
          <div className="sup-overlay-toolbar">
            <button className="btn btn-sm" onClick={() => setMapImportModal(true)}>
              + Importar mapa
            </button>
          </div>
          {mapsRows.length === 0 ? (
            <div className="sup-org-empty">Sin mapas importados todavía.</div>
          ) : (
            <table className="sup-manage-table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Estado</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {mapsRows.map((m) => (
                  <tr key={m.id}>
                    <td>
                      {m.name}
                      {m.active && <span className="sup-badge">Activo</span>}
                    </td>
                    <td title={m.error_message || ''}>{MAP_STATUS_LABEL[m.status] || m.status}</td>
                    <td className="sup-org-row-actions">
                      {m.status === 'ready' &&
                        (m.active ? (
                          <button className="btn btn-sm btn-danger" onClick={() => deactivateMap(m.id)}>
                            Desactivar
                          </button>
                        ) : (
                          <button className="btn btn-sm" onClick={() => activateMap(m.id)}>
                            Activar
                          </button>
                        ))}
                      <button className="btn btn-sm" onClick={() => renameMap(m.id, m.name)}>
                        Renombrar
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => deleteMapRow(m)}>
                        Eliminar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>

        <Modal open={mapImportModal} title="Importar mapa satelital/drone" onClose={() => setMapImportModal(false)}>
          <div className="gg-modal-field">
            <label>Nombre</label>
            <input
              placeholder="ej. Levantamiento julio 2026"
              value={mapImportForm.name}
              onChange={(e) => setMapImportForm({ ...mapImportForm, name: e.target.value })}
            />
          </div>
          <div className="gg-modal-field">
            <label>Imagen (.tif / .jpg)</label>
            <input ref={imageInputRef} type="file" accept=".tif,.tiff,.jpg,.jpeg" />
          </div>
          <div className="gg-modal-field">
            <label>World file (.tfw / .jpw)</label>
            <input ref={worldInputRef} type="file" accept=".tfw,.jpw,.wld" />
          </div>
          <div className="gg-modal-field">
            <label>Sistema de coordenadas (CRS)</label>
            <select value={mapImportForm.crs} onChange={(e) => setMapImportForm({ ...mapImportForm, crs: e.target.value })}>
              {CRS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          {mapImportError && <div style={{ color: '#e5484d', fontSize: 12 }}>{mapImportError}</div>}
          <div className="gg-modal-actions">
            <button className="btn btn-sm" onClick={() => setMapImportModal(false)}>
              Cancelar
            </button>
            <button className="btn btn-sm" onClick={importMap}>
              Importar
            </button>
          </div>
        </Modal>
      </>
    );
  },
);
