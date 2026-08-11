import { useMapLibreMap, useMapMode, useSatelliteLayers } from '@gaga-gps/map-core';
import type { ActiveMap } from '@gaga-gps/shared-types';
import type { Feature, FeatureCollection } from 'geojson';
import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { adminApi } from '../api';
import type { DeviceRow, HistoryPoint } from '../types';

export function HistorySection() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { map, loaded } = useMapLibreMap(containerRef, { center: [-103.7247, 19.2433], zoom: 10 });
  const [mapMode, setMapMode] = useMapMode('gaga_admin_hist_map_mode', 'streets');
  const [activeMaps, setActiveMaps] = useState<ActiveMap[]>([]);
  const markerRef = useRef<maplibregl.Marker | null>(null);

  useSatelliteLayers(map, loaded, activeMaps, mapMode, 'route-line');

  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [sliderIndex, setSliderIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const playbackRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setDevices(await adminApi.get<DeviceRow[]>('/api/devices'));
      } catch (err) {
        console.error('Error cargando dispositivos para Historial:', err);
      }
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    (async () => {
      try {
        setActiveMaps(await fetch('/tiles/active-maps.json').then((r) => r.json()));
      } catch (err) {
        console.error('Error cargando mapas activos:', err);
        setActiveMaps([]);
      }
    })();
  }, [loaded]);

  const hasMaps = activeMaps.length > 0;
  useEffect(() => {
    if (!hasMaps && mapMode !== 'streets') setMapMode('streets');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMaps]);

  function stopPlayback() {
    if (playbackRef.current) {
      clearInterval(playbackRef.current);
      playbackRef.current = null;
    }
    setPlaying(false);
  }

  function renderRoute(points: HistoryPoint[]) {
    if (!map) return;

    function draw() {
      if (!map!.isStyleLoaded()) {
        map!.once('idle', draw);
        return;
      }
      if (!points.length) return;

      const segments: Feature[] = [];
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        segments.push({
          type: 'Feature',
          properties: { color: a.zones.length > 0 ? '#4f8ff0' : '#e5484d' },
          geometry: {
            type: 'LineString',
            coordinates: [
              [a.longitude, a.latitude],
              [b.longitude, b.latitude],
            ],
          },
        });
      }

      const geojson: FeatureCollection = { type: 'FeatureCollection', features: segments };
      const source = map!.getSource('route') as maplibregl.GeoJSONSource | undefined;
      if (source) {
        source.setData(geojson);
      } else {
        map!.addSource('route', { type: 'geojson', data: geojson });
        map!.addLayer({
          id: 'route-line',
          type: 'line',
          source: 'route',
          paint: { 'line-color': ['get', 'color'], 'line-width': 4 },
        });
      }

      if (markerRef.current) markerRef.current.remove();
      markerRef.current = new maplibregl.Marker({ color: '#00aaff' })
        .setLngLat([points[0].longitude, points[0].latitude])
        .addTo(map!);

      const lons = points.map((p) => p.longitude);
      const lats = points.map((p) => p.latitude);
      map!.fitBounds(
        [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        { padding: 40, maxZoom: 16 },
      );
    }
    draw();
  }

  async function loadHistory() {
    if (!deviceId || !from || !to) {
      alert('Complete todos los campos');
      return;
    }
    stopPlayback();

    const data = await adminApi.get<HistoryPoint[]>(
      `/api/reports/history-with-zones?deviceId=${encodeURIComponent(deviceId)}&from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`,
    );
    setHistory(data);
    setSliderIndex(0);
    renderRoute(data);
  }

  function togglePlayback() {
    if (playbackRef.current) {
      stopPlayback();
      return;
    }
    if (!history.length) return;

    setPlaying(true);
    playbackRef.current = setInterval(() => {
      setSliderIndex((prev) => {
        const next = prev + 1;
        if (next >= history.length) {
          stopPlayback();
          return prev;
        }
        return next;
      });
    }, 300);
  }

  useEffect(() => {
    const point = history[sliderIndex];
    if (point && markerRef.current) {
      markerRef.current.setLngLat([point.longitude, point.latitude]);
    }
  }, [sliderIndex, history]);

  const currentPoint = history[sliderIndex];
  const inZoneCount = history.filter((p) => p.zones.length > 0).length;

  return (
    <>
      <div className="card">
        <div className="form-row">
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            <option value="">Selecciona un dispositivo…</option>
            {devices.map((d) => (
              <option key={d.unique_id} value={d.unique_id}>
                {d.name} ({d.unique_id})
              </option>
            ))}
          </select>
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
          <button className="btn btn-sm" onClick={loadHistory}>
            Buscar
          </button>
        </div>

        {!hasMaps && (
          <div className="no-maps-banner visible">
            <span>
              No hay ningún mapa satelital importado todavía — los modos Satelital/Mixto no
              mostrarán nada.
            </span>
          </div>
        )}

        <div id="ad-hist-map">
          <div className="map-mode-selector">
            <button
              className={`map-mode-btn${mapMode === 'streets' ? ' active' : ''}`}
              onClick={() => setMapMode('streets')}
            >
              Calles
            </button>
            <button
              className={`map-mode-btn${mapMode === 'satellite' ? ' active' : ''}`}
              disabled={!hasMaps}
              onClick={() => setMapMode('satellite')}
            >
              Satelital
            </button>
            <button
              className={`map-mode-btn${mapMode === 'hybrid' ? ' active' : ''}`}
              disabled={!hasMaps}
              onClick={() => setMapMode('hybrid')}
            >
              Mixto
            </button>
          </div>
          <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        </div>

        <div className="form-row" style={{ marginTop: 8, alignItems: 'center' }}>
          <button className="btn btn-sm" style={{ width: 'auto' }} onClick={togglePlayback}>
            {playing ? 'Pausar' : 'Reproducir'}
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(0, history.length - 1)}
            value={sliderIndex}
            style={{ flex: 1 }}
            onChange={(e) => setSliderIndex(parseInt(e.target.value, 10))}
          />
          <span style={{ fontSize: 12, color: '#8b949e', minWidth: 150 }}>
            {currentPoint
              ? `${new Date(currentPoint.fix_time).toLocaleString()} — ${(currentPoint.speed * 3.6).toFixed(1)} km/h`
              : '-'}
          </span>
        </div>
        <div className="form-row" style={{ fontSize: 12, color: '#8b949e' }}>
          <span className="zone-in">Dentro de zona autorizada</span>
          <span className="zone-out">Fuera de toda zona autorizada</span>
          <span>
            {history.length
              ? `${inZoneCount}/${history.length} puntos dentro de zona autorizada`
              : 'Sin datos en el rango seleccionado'}
          </span>
        </div>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Lat</th>
              <th>Lon</th>
              <th>Velocidad (km/h)</th>
              <th>Zona</th>
            </tr>
          </thead>
          <tbody>
            {history.map((p, i) => (
              <tr key={i}>
                <td>{new Date(p.fix_time).toLocaleString()}</td>
                <td>{p.latitude}</td>
                <td>{p.longitude}</td>
                <td>{(p.speed * 3.6).toFixed(1)}</td>
                <td className={p.zones.length ? 'zone-in' : 'zone-out'}>
                  {p.zones.length ? p.zones.map((z) => z.name).join(', ') : 'Fuera de zona'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
