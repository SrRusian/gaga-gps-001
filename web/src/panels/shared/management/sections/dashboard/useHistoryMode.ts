import { getStoredToken } from '@gaga-gps/client';
import { flyToBounds } from '@gaga-gps/map-core';
import type { Feature, FeatureCollection } from 'geojson';
import maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { adminApi } from '../../api';
import type { HistoryPoint } from '../../types';
import type { Scope } from './scope';

export function formatHistoryDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface UseHistoryModeOptions {
  map: maplibregl.Map | null;
  scope: Scope;
  // historyMode vive como useState plano en el orquestador (DashboardSection) en vez de aqui,
  // porque useDashboardMap TAMBIEN lo necesita (para ocultar los marcadores de vehiculo en vivo) y
  // useHistoryMode necesita `map` (que produce useDashboardMap) - pasarlo desde afuera rompe ese
  // ciclo sin necesidad de refs.
  historyMode: boolean;
  setHistoryMode: (v: boolean) => void;
}

export function useHistoryMode({ map, scope, historyMode, setHistoryMode }: UseHistoryModeOptions) {
  const [historyDeviceId, setHistoryDeviceId] = useState('');
  const [historyFrom, setHistoryFrom] = useState('');
  const [historyTo, setHistoryTo] = useState('');
  const [historyPoints, setHistoryPoints] = useState<HistoryPoint[]>([]);
  const [historySliderIndex, setHistorySliderIndex] = useState(0);
  const [historyPlaying, setHistoryPlaying] = useState(false);
  const [showHistoryPanel, setShowHistoryPanel] = useState(true);
  const [csvExporting, setCsvExporting] = useState(false);
  const historyMarkerRef = useRef<maplibregl.Marker | null>(null);
  const historyPlaybackRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function enterHistoryMode() {
    setHistoryMode(true);
  }

  function clearHistoryRoute() {
    if (!map) return;
    const source = map.getSource('route') as GeoJSONSource | undefined;
    source?.setData({ type: 'FeatureCollection', features: [] });
    if (historyMarkerRef.current) {
      historyMarkerRef.current.remove();
      historyMarkerRef.current = null;
    }
  }

  function stopHistoryPlayback() {
    if (historyPlaybackRef.current) {
      clearInterval(historyPlaybackRef.current);
      historyPlaybackRef.current = null;
    }
    setHistoryPlaying(false);
  }

  function exitHistoryMode() {
    stopHistoryPlayback();
    setHistoryMode(false);
    setHistoryPoints([]);
    setHistorySliderIndex(0);
    setHistoryDeviceId('');
    setHistoryFrom('');
    setHistoryTo('');
    clearHistoryRoute();
  }

  useEffect(() => {
    if (historyMode) exitHistoryMode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  function renderHistoryRoute(points: HistoryPoint[]) {
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
      const source = map!.getSource('route') as GeoJSONSource | undefined;
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

      if (historyMarkerRef.current) historyMarkerRef.current.remove();
      historyMarkerRef.current = new maplibregl.Marker({ color: '#00aaff' })
        .setLngLat([points[0].longitude, points[0].latitude])
        .addTo(map!);

      const lons = points.map((p) => p.longitude);
      const lats = points.map((p) => p.latitude);
      flyToBounds(
        map,
        [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        { padding: 60, maxZoom: 16 },
      );
    }
    draw();
  }

  async function loadHistoryPoints() {
    if (!historyDeviceId || !historyFrom || !historyTo) {
      alert('Complete dispositivo, desde y hasta');
      return;
    }
    stopHistoryPlayback();
    try {
      const projectParam = typeof scope === 'number' ? `&projectId=${scope}` : '';
      const data = await adminApi.get<HistoryPoint[]>(
        `/api/reports/history-with-zones?deviceId=${encodeURIComponent(historyDeviceId)}&from=${new Date(historyFrom).toISOString()}&to=${new Date(historyTo).toISOString()}${projectParam}`,
      );
      setHistoryPoints(data);
      setHistorySliderIndex(0);
      renderHistoryRoute(data);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error obteniendo el historial');
    }
  }

  async function exportHistoryCsv() {
    if (!historyDeviceId || !historyFrom || !historyTo) {
      alert('Complete dispositivo, desde y hasta');
      return;
    }
    setCsvExporting(true);
    try {
      const projectParam = typeof scope === 'number' ? `&projectId=${scope}` : '';
      const url = `/api/reports/history/csv?deviceId=${encodeURIComponent(historyDeviceId)}&from=${new Date(historyFrom).toISOString()}&to=${new Date(historyTo).toISOString()}${projectParam}`;
      const token = getStoredToken();
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Error ${res.status}`);
      }
      // blob: Chrome bloquea esta descarga fuera de HTTPS/localhost exacto
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `historial_${historyDeviceId}.csv`;
      a.click();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error exportando el historial');
    } finally {
      setCsvExporting(false);
    }
  }

  function toggleHistoryPlayback() {
    if (historyPlaybackRef.current) {
      stopHistoryPlayback();
      return;
    }
    if (!historyPoints.length) return;
    setHistoryPlaying(true);
    historyPlaybackRef.current = setInterval(() => {
      setHistorySliderIndex((prev) => {
        const next = prev + 1;
        if (next >= historyPoints.length) {
          stopHistoryPlayback();
          return prev;
        }
        return next;
      });
    }, 300);
  }

  useEffect(() => {
    const point = historyPoints[historySliderIndex];
    if (point && historyMarkerRef.current) {
      historyMarkerRef.current.setLngLat([point.longitude, point.latitude]);
    }
  }, [historySliderIndex, historyPoints]);

  useEffect(() => stopHistoryPlayback, []);

  return {
    historyMode,
    historyDeviceId,
    setHistoryDeviceId,
    historyFrom,
    setHistoryFrom,
    historyTo,
    setHistoryTo,
    historyPoints,
    historySliderIndex,
    setHistorySliderIndex,
    historyPlaying,
    showHistoryPanel,
    setShowHistoryPanel,
    csvExporting,
    enterHistoryMode,
    exitHistoryMode,
    loadHistoryPoints,
    exportHistoryCsv,
    toggleHistoryPlayback,
  };
}

export type HistoryModeAdmin = ReturnType<typeof useHistoryMode>;
