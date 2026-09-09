import { getStoredToken } from '@gaga-gps/client';
import { circleToPolygon, flyToBounds, flyToPoint, lineToBufferPolygon } from '@gaga-gps/map-core';
import type MapboxDraw from '@mapbox/mapbox-gl-draw';
import type { Feature, FeatureCollection, LineString } from 'geojson';
import maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { adminApi } from '../../api';
import type { GeofenceRow } from '../../types';
import type { Scope } from './scope';

export type GeofenceShape = 'circle' | 'polygon' | 'polyline';

export const SHAPE_HINTS: Record<GeofenceShape, string> = {
  circle: 'Clic en el mapa para fijar el centro.',
  polygon:
    'Dibuje el polígono en el mapa (clic para cada vértice, doble clic para terminar antes de presionar Crear).',
  polyline:
    'Dibuje la ruta en el mapa (clic para cada punto, doble clic para terminar antes de presionar Crear).',
};

const PREVIEW_COLOR = '#a855f7';
const PREVIEW_SOURCE_ID = 'geofence-draft-preview';

export interface GeofenceFormState {
  name: string;
  type: string;
  radius: string;
  corridorWidth: string;
  // solo aplica a poligono - true (default) = zona completa (ST_Contains), false = alerta al
  // cruzar el borde (un solo ancho de deteccion, reusa corridorWidth)
  filled: boolean;
  // solo aplica a polilinea - true (default, "Ruta autorizada" historico) = debe quedarse DENTRO
  // del ancho; false = "no tocar" - alerta al acercarse al ancho de la linea
  stayInside: boolean;
}

export interface UseGeofencesAdminOptions {
  map: maplibregl.Map | null;
  scope: Scope;
  drawRef: MutableRefObject<MapboxDraw | null>;
  circleMarkerRef: MutableRefObject<maplibregl.Marker | null>;
}

// Preview morado (PREVIEW_SOURCE_ID) es exclusivo de geocercas - equipo estatico tiene el suyo
// propio en useEquipmentAdmin. drawRef/circleMarkerRef SI son compartidos con el click handler del
// mapa (useMapDrawing) porque ese handler decide entre "coloco equipo" o "fijo centro de circulo"
// segun cual panel este abierto - de ahi que estos dos refs los cree el orquestador, no este hook.
export function useGeofencesAdmin({ map, scope, drawRef, circleMarkerRef }: UseGeofencesAdminOptions) {
  const [allGeofences, setAllGeofences] = useState<GeofenceRow[]>([]);
  const [showGeoPanel, setShowGeoPanel] = useState(false);
  const [geoShape, setGeoShape] = useState<GeofenceShape>('polygon');
  const [geoSelectedCenter, setGeoSelectedCenter] = useState<{ lat: number; lon: number } | null>(null);
  const [geoEditingId, setGeoEditingId] = useState<number | null>(null);
  const [geoTargetProjectId, setGeoTargetProjectId] = useState('');
  const [geofenceForm, setGeofenceForm] = useState<GeofenceFormState>({
    name: '',
    type: 'warning',
    radius: '',
    corridorWidth: '',
    filled: true,
    stayInside: true,
  });
  // seleccion de filas via checkbox - se reutiliza tanto para exportar (GeoJSON/KML) como para
  // eliminar varias a la vez
  const [selectedGeofenceIds, setSelectedGeofenceIds] = useState<Set<number>>(new Set());
  const [importFeedback, setImportFeedback] = useState<{ text: string; ok: boolean }>({
    text: '',
    ok: true,
  });
  const [geoImportModal, setGeoImportModal] = useState(false);
  const [geoImportProjectId, setGeoImportProjectId] = useState('');
  const geoImportFileRef = useRef<HTMLInputElement>(null);

  // shadows de refs para que el click/draw handler del mapa (creado una sola vez por [map, loaded]
  // en useMapDrawing) siempre lea el valor mas reciente, no el capturado en su primer render
  const geoShapeRef = useRef(geoShape);
  geoShapeRef.current = geoShape;
  const showGeoPanelRef = useRef(showGeoPanel);
  showGeoPanelRef.current = showGeoPanel;

  async function loadGeofences() {
    setAllGeofences(await adminApi.get<GeofenceRow[]>('/api/geofences'));
    setSelectedGeofenceIds(new Set());
  }

  const scopedGeofences = useMemo(() => {
    if (scope === 'global') return allGeofences;
    if (typeof scope === 'number') return allGeofences.filter((g) => g.project_id === scope);
    return [];
  }, [allGeofences, scope]);

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
      paint: { 'line-color': PREVIEW_COLOR, 'line-width': 3, 'line-dasharray': [2, 1] },
    });
  }

  function clearDraftPreview() {
    if (!map) return;
    const source = map.getSource(PREVIEW_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData({ type: 'FeatureCollection', features: [] });
  }

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
      if (line && widthMeters > 0) {
        features.push({
          type: 'Feature',
          properties: { ring: 'core' },
          geometry: lineToBufferPolygon(line.geometry, widthMeters),
        });
      }
    }

    source.setData({ type: 'FeatureCollection', features });
  }

  const updateDraftPreviewRef = useRef(updateDraftPreview);
  updateDraftPreviewRef.current = updateDraftPreview;

  useEffect(() => {
    updateDraftPreviewRef.current();
  }, [showGeoPanel, geoShape, geoSelectedCenter, geofenceForm.radius, geofenceForm.corridorWidth]);

  function resetGeofenceForm() {
    setGeoEditingId(null);
    setGeoTargetProjectId('');
    setGeofenceForm({
      name: '',
      type: 'warning',
      radius: '',
      corridorWidth: '',
      filled: true,
      stayInside: true,
    });
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

  function editGeofenceRow(g: GeofenceRow) {
    if (!map) return;
    setShowGeoPanel(true);
    setGeoEditingId(g.id);
    setGeoShape(g.shape_type);
    setGeofenceForm({
      name: g.name,
      type: g.type,
      radius: g.radius_meters != null ? String(g.radius_meters) : '',
      corridorWidth: g.corridor_width_meters != null ? String(g.corridor_width_meters) : '',
      filled: g.filled,
      stayInside: g.stay_inside,
    });
    drawRef.current?.deleteAll();
    if (g.shape_type === 'circle') {
      setGeoSelectedCenter({ lat: g.center_lat as number, lon: g.center_lon as number });
      if (circleMarkerRef.current) circleMarkerRef.current.remove();
      circleMarkerRef.current = new maplibregl.Marker()
        .setLngLat([g.center_lon as number, g.center_lat as number])
        .addTo(map);
      flyToPoint(map, g.center_lat as number, g.center_lon as number, { zoom: 15 });
    } else if (g.geometry) {
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
        flyToBounds(map, bounds, { padding: 80, maxZoom: 17 });
      }
    }
  }

  async function saveGeofenceRow() {
    const isEditing = geoEditingId != null;
    const effectiveProjectId =
      typeof scope === 'number' ? scope : geoTargetProjectId ? Number(geoTargetProjectId) : null;
    if (!isEditing && !effectiveProjectId) {
      alert('Selecciona un proyecto');
      return;
    }
    const method = isEditing ? 'patch' : 'post';
    const url = isEditing ? `/api/geofences/${geoEditingId}` : '/api/geofences';

    try {
      if (geoShape === 'circle') {
        const radiusMeters = parseFloat(geofenceForm.radius);
        if (!geofenceForm.name || !geoSelectedCenter || !radiusMeters) {
          alert('Complete nombre, centro (clic en mapa) y radio');
          return;
        }
        await adminApi[method](url, {
          name: geofenceForm.name,
          type: geofenceForm.type,
          shapeType: 'circle',
          centerLat: geoSelectedCenter.lat,
          centerLon: geoSelectedCenter.lon,
          radiusMeters,
          ...(isEditing ? {} : { projectId: effectiveProjectId }),
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
          const filled = geofenceForm.filled;
          let corridorWidthMeters: number | undefined;
          if (!filled) {
            corridorWidthMeters = parseFloat(geofenceForm.corridorWidth);
            if (!corridorWidthMeters) {
              alert('Complete el ancho de detección del borde (polígono sin relleno)');
              return;
            }
          }
          await adminApi[method](url, {
            name: geofenceForm.name,
            type: geofenceForm.type,
            shapeType: 'polygon',
            geometry,
            filled,
            ...(filled ? {} : { corridorWidthMeters }),
            ...(isEditing ? {} : { projectId: effectiveProjectId }),
          });
        } else {
          const corridorWidthMeters = parseFloat(geofenceForm.corridorWidth);
          if (!geofenceForm.name || !corridorWidthMeters) {
            alert('Complete nombre y ancho de la línea');
            return;
          }
          await adminApi[method](url, {
            name: geofenceForm.name,
            type: geofenceForm.type,
            shapeType: 'polyline',
            geometry,
            corridorWidthMeters,
            stayInside: geofenceForm.stayInside,
            ...(isEditing ? {} : { projectId: effectiveProjectId }),
          });
        }
      }

      resetGeofenceForm();
      loadGeofences();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error guardando la geocerca');
    }
  }

  async function deleteGeofenceRow(g: GeofenceRow) {
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
      await adminApi.delete(`/api/geofences/${g.id}`);
      loadGeofences();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error eliminando la geocerca');
    }
  }

  // borrado masivo - misma seleccion por casilla que ya se usaba para exportar. No se puede pedir
  // escribir cada nombre exacto como en el borrado individual (serian N confirmaciones), asi que
  // se lista lo que se va a eliminar en el propio mensaje y se pide una sola palabra fija
  async function deleteSelectedGeofences() {
    const selected = scopedGeofences.filter((g) => selectedGeofenceIds.has(g.id));
    if (selected.length === 0) {
      alert('Selecciona al menos una geocerca para eliminar (marca su casilla).');
      return;
    }
    const names = selected.map((g) => g.name).join('\n- ');
    const typed = prompt(
      `Esta acción no se puede deshacer. Se dejará de evaluar en tiempo real cada una de estas ` +
        `${selected.length} geocercas de inmediato:\n\n- ${names}\n\nPara confirmar, escriba ELIMINAR:`,
    );
    if (typed === null) return;
    if (typed !== 'ELIMINAR') {
      alert('No se escribió ELIMINAR - no se eliminó ninguna geocerca');
      return;
    }
    const failed: string[] = [];
    for (const g of selected) {
      try {
        await adminApi.delete(`/api/geofences/${g.id}`);
      } catch (err) {
        failed.push(`${g.name}: ${err instanceof Error ? err.message : 'error desconocido'}`);
      }
    }
    loadGeofences();
    if (failed.length > 0) {
      alert(`No se pudieron eliminar ${failed.length} geocerca(s):\n\n${failed.join('\n')}`);
    }
  }

  function toggleGeofenceSelected(id: number, checked: boolean) {
    setSelectedGeofenceIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function exportGeofences(format: 'geojson' | 'kml') {
    if (selectedGeofenceIds.size === 0) {
      alert('Selecciona al menos una geocerca para exportar (marca su casilla).');
      return;
    }
    const ids = [...selectedGeofenceIds].join(',');
    const token = getStoredToken();
    const a = document.createElement('a');
    a.href = `/api/geofences/export.${format}?ids=${ids}&token=${encodeURIComponent(token || '')}`;
    a.download = `geocercas.${format}`;
    a.click();
  }

  function openGeoImportModal() {
    setGeoImportProjectId('');
    setImportFeedback({ text: '', ok: true });
    setGeoImportModal(true);
  }

  async function importGeofences() {
    const file = geoImportFileRef.current?.files?.[0];
    if (!file) {
      setImportFeedback({ ok: false, text: 'Selecciona un archivo GeoJSON o KML' });
      return;
    }
    const effectiveProjectId =
      typeof scope === 'number' ? scope : geoImportProjectId ? Number(geoImportProjectId) : null;
    if (!effectiveProjectId) {
      setImportFeedback({ ok: false, text: 'Selecciona un proyecto' });
      return;
    }
    setImportFeedback({ text: 'Importando...', ok: true });
    try {
      const text = await file.text();
      const format = file.name.toLowerCase().endsWith('.kml') ? 'kml' : 'geojson';
      const data = format === 'geojson' ? JSON.parse(text) : text;
      const result = await adminApi.post<{ imported: number; skipped: number; errors: string[] }>(
        '/api/geofences/import',
        { format, data, projectId: effectiveProjectId },
      );
      setImportFeedback({
        ok: result.imported > 0,
        text: `Importadas: ${result.imported} - Omitidas: ${result.skipped}${result.errors.length ? ` (${result.errors.join('; ')})` : ''}`,
      });
      loadGeofences();
      if (result.imported > 0) {
        setGeoImportModal(false);
      }
    } catch (err) {
      setImportFeedback({ ok: false, text: `Error: ${err instanceof Error ? err.message : String(err)}` });
    }
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

  return {
    allGeofences,
    scopedGeofences,
    showGeoPanel,
    setShowGeoPanel,
    geoShape,
    setGeoShape,
    geoShapeRef,
    showGeoPanelRef,
    geoSelectedCenter,
    setGeoSelectedCenter,
    geoEditingId,
    geoTargetProjectId,
    setGeoTargetProjectId,
    geofenceForm,
    setGeofenceForm,
    selectedGeofenceIds,
    setSelectedGeofenceIds,
    importFeedback,
    geoImportModal,
    setGeoImportModal,
    geoImportProjectId,
    setGeoImportProjectId,
    geoImportFileRef,
    loadGeofences,
    ensureDraftPreviewLayer,
    updateDraftPreviewRef,
    resetGeofenceForm,
    closeGeoPanel,
    editGeofenceRow,
    saveGeofenceRow,
    deleteGeofenceRow,
    deleteSelectedGeofences,
    toggleGeofenceSelected,
    exportGeofences,
    openGeoImportModal,
    importGeofences,
    onShapeChange,
    cancelDrawing,
    finishDrawing,
  };
}

export type GeofencesAdmin = ReturnType<typeof useGeofencesAdmin>;
