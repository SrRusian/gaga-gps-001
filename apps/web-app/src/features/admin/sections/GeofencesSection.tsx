import { getStoredToken } from '@gaga-gps/client';
import {
  useGeofenceLayer,
  useMapLibreMap,
  useMapMode,
  useSatelliteLayers,
} from '@gaga-gps/map-core';
import type { ActiveMap } from '@gaga-gps/shared-types';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { adminApi } from '../api';
import { toGeofence } from '../geofenceMapper';
import type { GeofenceRow } from '../types';

type Shape = 'circle' | 'polygon' | 'polyline';

const SHAPE_HINTS: Record<Shape, string> = {
  circle: 'Clic en el mapa para fijar el centro.',
  polygon:
    'Dibuje el polígono en el mapa (clic para cada vértice, doble clic para terminar antes de presionar Crear).',
  polyline:
    'Dibuje la ruta en el mapa (clic para cada punto, doble clic para terminar antes de presionar Crear).',
};

export function GeofencesSection() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { map, loaded } = useMapLibreMap(containerRef, { center: [-103.7247, 19.2433], zoom: 10 });
  const [mapMode, setMapMode] = useMapMode('gaga_admin_map_mode', 'streets');
  const drawRef = useRef<MapboxDraw | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);

  const [rows, setRows] = useState<GeofenceRow[]>([]);
  const [activeMaps, setActiveMaps] = useState<ActiveMap[]>([]);
  const [shape, setShape] = useState<Shape>('circle');
  const [selectedCenter, setSelectedCenter] = useState<{ lat: number; lon: number } | null>(null);
  const [form, setForm] = useState({
    name: '',
    type: 'warning',
    radius: '',
    corridorWidth: '',
    corridorMargin: '',
  });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [selectedExportIds, setSelectedExportIds] = useState<Set<number>>(new Set());
  const [importFeedback, setImportFeedback] = useState<{ text: string; ok: boolean }>({
    text: '',
    ok: true,
  });

  const geofences = rows.map(toGeofence);
  useGeofenceLayer(map, loaded, geofences);
  useSatelliteLayers(map, loaded, activeMaps, mapMode);

  async function loadGeofences() {
    setRows(await adminApi.get<GeofenceRow[]>('/api/geofences'));
    setSelectedExportIds(new Set());
  }

  async function loadActiveMaps() {
    try {
      setActiveMaps(await fetch('/tiles/active-maps.json').then((r) => r.json()));
    } catch (err) {
      console.error('Error cargando mapas activos:', err);
      setActiveMaps([]);
    }
  }

  useEffect(() => {
    loadGeofences();
    loadActiveMaps();
  }, []);

  const hasMaps = activeMaps.length > 0;
  useEffect(() => {
    if (!hasMaps && mapMode !== 'streets') setMapMode('streets');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMaps]);

  // ── MapboxDraw + clic para círculo ────────────────────────────
  useEffect(() => {
    if (!map || !loaded || drawRef.current) return;

    const draw = new MapboxDraw({ displayControlsDefault: false, controls: {} });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- maplibregl y mapbox-gl-draw difieren levemente en sus tipos de Map, pero son compatibles en tiempo de ejecución
    map.addControl(draw as any);
    drawRef.current = draw;

    const handleClick = (e: maplibregl.MapMouseEvent) => {
      if (drawShapeRef.current !== 'circle') return;
      const center = { lat: e.lngLat.lat, lon: e.lngLat.lng };
      setSelectedCenter(center);
      if (markerRef.current) markerRef.current.remove();
      markerRef.current = new maplibregl.Marker().setLngLat(e.lngLat).addTo(map);
    };
    map.on('click', handleClick);

    return () => {
      map.off('click', handleClick);
    };
  }, [map, loaded]);

  // Ref para leer el shape actual dentro del listener de click sin
  // tener que recrearlo (el listener se registra una sola vez).
  const drawShapeRef = useRef(shape);
  drawShapeRef.current = shape;

  function onShapeChange(next: Shape) {
    setShape(next);
    drawRef.current?.deleteAll();
    if (next === 'polygon') drawRef.current?.changeMode('draw_polygon');
    else if (next === 'polyline') drawRef.current?.changeMode('draw_line_string');
  }

  function cancelDrawing() {
    drawRef.current?.deleteAll();
    if (shape === 'polygon') drawRef.current?.changeMode('draw_polygon');
    else if (shape === 'polyline') drawRef.current?.changeMode('draw_line_string');
  }

  function resetForm() {
    setEditingId(null);
    setForm({ name: '', type: 'warning', radius: '', corridorWidth: '', corridorMargin: '' });
    setSelectedCenter(null);
    if (markerRef.current) {
      markerRef.current.remove();
      markerRef.current = null;
    }
    drawRef.current?.deleteAll();
  }

  function editGeofence(id: number) {
    const g = rows.find((r) => r.id === id);
    if (!g || !map) return;

    setEditingId(id);
    setShape(g.shape_type);
    setForm({
      name: g.name,
      type: g.type,
      radius: g.radius_meters != null ? String(g.radius_meters) : '',
      corridorWidth: g.corridor_width_meters != null ? String(g.corridor_width_meters) : '',
      corridorMargin:
        g.corridor_danger_margin_meters != null ? String(g.corridor_danger_margin_meters) : '',
    });

    drawRef.current?.deleteAll();
    if (g.shape_type === 'circle') {
      setSelectedCenter({ lat: g.center_lat as number, lon: g.center_lon as number });
      if (markerRef.current) markerRef.current.remove();
      markerRef.current = new maplibregl.Marker()
        .setLngLat([g.center_lon as number, g.center_lat as number])
        .addTo(map);
      map.flyTo({ center: [g.center_lon as number, g.center_lat as number], zoom: 15 });
    } else if (g.geometry) {
      drawRef.current?.add({ type: 'Feature', properties: {}, geometry: g.geometry });
    }
  }

  async function saveGeofence() {
    const isEditing = editingId != null;
    const method = isEditing ? 'patch' : 'post';
    const url = isEditing ? `/api/geofences/${editingId}` : '/api/geofences';

    try {
      if (shape === 'circle') {
        const radiusMeters = parseFloat(form.radius);
        if (!form.name || !selectedCenter || !radiusMeters) {
          alert('Complete nombre, centro (clic en mapa) y radio');
          return;
        }
        await adminApi[method](url, {
          name: form.name,
          type: form.type,
          shapeType: 'circle',
          centerLat: selectedCenter.lat,
          centerLon: selectedCenter.lon,
          radiusMeters,
        });
      } else {
        // mapbox-gl-draw ya incluye la figura en getAll() desde el
        // primer clic, antes de terminarla — sin este chequeo, un
        // "Crear" a medio dibujar (sin el doble clic final) guardaría
        // una geometría incompleta/inválida en vez de avisar.
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

        if (shape === 'polygon') {
          if (!form.name) {
            alert('Complete el nombre');
            return;
          }
          await adminApi[method](url, {
            name: form.name,
            type: form.type,
            shapeType: 'polygon',
            geometry,
          });
        } else {
          const corridorWidthMeters = parseFloat(form.corridorWidth);
          const corridorDangerMarginMeters = parseFloat(form.corridorMargin) || null;
          if (!form.name || !corridorWidthMeters) {
            alert('Complete nombre y ancho seguro del corredor');
            return;
          }
          await adminApi[method](url, {
            name: form.name,
            type: form.type,
            shapeType: 'polyline',
            geometry,
            corridorWidthMeters,
            corridorDangerMarginMeters,
          });
        }
      }

      resetForm();
      loadGeofences();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error guardando la geocerca');
    }
  }

  async function deleteGeofence(id: number) {
    if (!confirm('¿Eliminar geocerca?')) return;
    await adminApi.delete(`/api/geofences/${id}`);
    loadGeofences();
  }

  function toggleExportCheck(id: number, checked: boolean) {
    setSelectedExportIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function exportGeofences(format: 'geojson' | 'kml') {
    if (selectedExportIds.size === 0) {
      alert(
        'Selecciona al menos una geocerca para exportar (marca su casilla, o usa "seleccionar todas" junto a Nombre).',
      );
      return;
    }
    const ids = [...selectedExportIds].join(',');
    const res = await fetch(`/api/geofences/export.${format}?ids=${ids}`, {
      headers: { Authorization: `Bearer ${getStoredToken()}` },
    });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `geocercas.${format}`;
    a.click();
  }

  async function importGeofences(file: File) {
    setImportFeedback({ text: 'Importando...', ok: true });
    try {
      const text = await file.text();
      const format = file.name.toLowerCase().endsWith('.kml') ? 'kml' : 'geojson';
      const data = format === 'geojson' ? JSON.parse(text) : text;
      const result = await adminApi.post<{ imported: number; skipped: number; errors: string[] }>(
        '/api/geofences/import',
        { format, data },
      );
      setImportFeedback({
        ok: result.imported > 0,
        text: `Importadas: ${result.imported} — Omitidas: ${result.skipped}${result.errors.length ? ` (${result.errors.join('; ')})` : ''}`,
      });
      loadGeofences();
    } catch (err) {
      setImportFeedback({
        ok: false,
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return (
    <>
      <div className="card">
        {!hasMaps && (
          <div className="no-maps-banner visible">
            <span>
              ⚠️ No hay ningún mapa satelital importado todavía — los modos Satelital/Mixto no
              mostrarán nada.
            </span>
          </div>
        )}
        <div id="ad-map">
          <div className="map-mode-selector">
            <button
              className={`map-mode-btn${mapMode === 'streets' ? ' active' : ''}`}
              onClick={() => setMapMode('streets')}
            >
              🗺️ Calles
            </button>
            <button
              className={`map-mode-btn${mapMode === 'satellite' ? ' active' : ''}`}
              disabled={!hasMaps}
              onClick={() => setMapMode('satellite')}
            >
              🛰️ Satelital
            </button>
            <button
              className={`map-mode-btn${mapMode === 'hybrid' ? ' active' : ''}`}
              disabled={!hasMaps}
              onClick={() => setMapMode('hybrid')}
            >
              🔀 Mixto
            </button>
          </div>
          <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        </div>

        <div className="form-row">
          <label style={{ fontSize: 12, color: '#8b949e' }}>Forma:</label>
          <select
            value={shape}
            onChange={(e) => onShapeChange(e.target.value as Shape)}
            disabled={editingId != null}
          >
            <option value="circle">Círculo</option>
            <option value="polygon">Polígono (zona autorizada)</option>
            <option value="polyline">Ruta / corredor autorizado</option>
          </select>
          <span style={{ fontSize: 12, color: '#8b949e' }}>{SHAPE_HINTS[shape]}</span>
        </div>
        <div className="form-row">
          <input
            placeholder="Nombre"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value="warning">Advertencia (amarilla)</option>
            <option value="danger">Peligro (roja)</option>
          </select>
          {shape === 'circle' && (
            <>
              <input
                placeholder="Lat"
                readOnly
                value={selectedCenter ? selectedCenter.lat.toFixed(6) : ''}
              />
              <input
                placeholder="Lon"
                readOnly
                value={selectedCenter ? selectedCenter.lon.toFixed(6) : ''}
              />
              <input
                placeholder="Radio (m)"
                type="number"
                value={form.radius}
                onChange={(e) => setForm({ ...form, radius: e.target.value })}
              />
            </>
          )}
          {shape === 'polyline' && (
            <>
              <input
                placeholder="Ancho seguro (m)"
                type="number"
                value={form.corridorWidth}
                onChange={(e) => setForm({ ...form, corridorWidth: e.target.value })}
              />
              <input
                placeholder="Margen advertencia (m)"
                type="number"
                value={form.corridorMargin}
                onChange={(e) => setForm({ ...form, corridorMargin: e.target.value })}
              />
            </>
          )}
          <button className="btn btn-sm" onClick={saveGeofence}>
            {editingId != null ? 'Guardar cambios' : 'Crear'}
          </button>
          {shape !== 'circle' && editingId == null && (
            <button className="btn btn-sm btn-danger" onClick={cancelDrawing}>
              Cancelar dibujo
            </button>
          )}
          {editingId != null && (
            <button className="btn btn-sm" style={{ width: 'auto' }} onClick={resetForm}>
              Cancelar edición
            </button>
          )}
        </div>
        <div className="form-row">
          <button className="btn btn-sm" onClick={() => exportGeofences('geojson')}>
            ⬇️ Exportar GeoJSON
          </button>
          <button className="btn btn-sm" onClick={() => exportGeofences('kml')}>
            ⬇️ Exportar KML
          </button>
          <input
            type="file"
            id="geo-import-file"
            accept=".geojson,.json,.kml"
            style={{ display: 'none' }}
            onChange={(e) =>
              e.target.files?.[0] &&
              importGeofences(e.target.files[0]).finally(() => (e.target.value = ''))
            }
          />
          <button
            className="btn btn-sm"
            onClick={() => document.getElementById('geo-import-file')?.click()}
          >
            ⬆️ Importar (GeoJSON/KML)
          </button>
        </div>
        <div
          style={{ fontSize: 12, marginTop: 6, color: importFeedback.ok ? '#00ff88' : '#ff4444' }}
        >
          {importFeedback.text}
        </div>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th style={{ width: 24 }}>
                <input
                  type="checkbox"
                  title="Seleccionar todas"
                  onChange={(e) =>
                    setSelectedExportIds(
                      e.target.checked ? new Set(rows.map((r) => r.id)) : new Set(),
                    )
                  }
                />
              </th>
              <th>Nombre</th>
              <th>Tipo</th>
              <th>Forma</th>
              <th>Detalle</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => {
              const detail =
                g.shape_type === 'circle'
                  ? `Radio: ${g.radius_meters}m`
                  : g.shape_type === 'polyline'
                    ? `Seguro: ${g.corridor_width_meters}m${g.corridor_danger_margin_meters ? ` + ${g.corridor_danger_margin_meters}m adv.` : ''}`
                    : `${(g.geometry as { coordinates?: number[][][] } | null)?.coordinates?.[0]?.length || 0} vértices`;
              return (
                <tr key={g.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedExportIds.has(g.id)}
                      onChange={(e) => toggleExportCheck(g.id, e.target.checked)}
                    />
                  </td>
                  <td>{g.name}</td>
                  <td>{g.type}</td>
                  <td>{g.shape_type}</td>
                  <td>{detail}</td>
                  <td>
                    <button className="btn btn-sm" onClick={() => editGeofence(g.id)}>
                      Editar
                    </button>{' '}
                    <button className="btn btn-sm btn-danger" onClick={() => deleteGeofence(g.id)}>
                      Eliminar
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
