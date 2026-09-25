import { getStoredToken } from '@gaga-gps/client';
import { flyToBounds, haversineMeters } from '@gaga-gps/map-core';
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

// tamaño de cada pagina pedida al servidor - mismo numero que HISTORY_PAGE_SIZE en
// reports.routes.ts (no importado directo, backend/frontend son paquetes separados, mismo criterio
// de duplicacion deliberada del resto del proyecto - si se cambia alla, replicar aqui)
const HISTORY_PAGE_SIZE = 5000;

// null = no esta cargando. {loaded,total} mientras carga - progreso REAL (paginas ya traidas del
// servidor), no un spinner indeterminado - pedido explicito: "que muestre una barra de carga
// progresiva interactiva real"
export interface HistoryLoadProgress {
  loaded: number;
  total: number;
}

export function useHistoryMode({ map, scope, historyMode, setHistoryMode }: UseHistoryModeOptions) {
  const [historyDeviceId, setHistoryDeviceId] = useState('');
  const [historyFrom, setHistoryFrom] = useState('');
  const [historyTo, setHistoryTo] = useState('');
  const [historyPoints, setHistoryPoints] = useState<HistoryPoint[]>([]);
  const [historyLoadProgress, setHistoryLoadProgress] = useState<HistoryLoadProgress | null>(null);
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
        // ruido GPS con el vehiculo detenido/casi detenido, no movimiento real - bug real
        // reportado con captura: un equipo parado horas enteras genera miles de fixes que
        // "tiemblan" unos metros alrededor del mismo punto (precision GPS + curso aleatorio a
        // velocidad casi cero), y dibujar una linea entre CADA fix consecutivo se ve como el
        // vehiculo manejando erraticamente sin haberse movido en realidad. El umbral no es un
        // numero fijo adivinado - es la suma de las 2 precisiones reales de cada fix (lo que dos
        // mediciones independientes con ruido podrian diferir SIN que haya habido movimiento real
        // alguno), con un piso de 6m por si algun fix reporta una precision sospechosamente buena
        const noiseThresholdMeters =
          Math.max(a.accuracy, 6) + Math.max(b.accuracy, 6);
        const distanceMeters = haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude);
        if (distanceMeters <= noiseThresholdMeters) continue;
        segments.push({
          type: 'Feature',
          properties: { color: a.zones.length > 0 ? '#008cff' : '#e5484d' },
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

  // sin limite en el TOTAL - pedido explicito: "debe darme todos los puntos sin limite... que el
  // servidor recibió". Se pagina en el cliente (HISTORY_PAGE_SIZE por vuelta) hasta agotar el rango
  // completo, actualizando historyLoadProgress en cada vuelta para una barra de progreso real. El
  // total se pide primero (GET /history-count, sin traer filas) para saber cuantas vueltas hacen
  // falta de antemano, en vez de un spinner indeterminado.
  async function loadHistoryPoints() {
    if (!historyDeviceId || !historyFrom || !historyTo) {
      alert('Complete dispositivo, desde y hasta');
      return;
    }
    stopHistoryPlayback();
    setHistoryPoints([]);
    setHistorySliderIndex(0);
    clearHistoryRoute();

    const projectParam = typeof scope === 'number' ? `&projectId=${scope}` : '';
    const baseParams = `deviceId=${encodeURIComponent(historyDeviceId)}&from=${new Date(historyFrom).toISOString()}&to=${new Date(historyTo).toISOString()}${projectParam}`;

    try {
      const { total } = await adminApi.get<{ total: number }>(`/api/reports/history-count?${baseParams}`);
      if (total <= 0) {
        setHistoryLoadProgress(null);
        return;
      }

      setHistoryLoadProgress({ loaded: 0, total });
      const accumulated: HistoryPoint[] = [];
      let offset = 0;
      while (offset < total) {
        const page = await adminApi.get<HistoryPoint[]>(
          `/api/reports/history-with-zones?${baseParams}&limit=${HISTORY_PAGE_SIZE}&offset=${offset}`,
        );
        // red de seguridad: si el rango ya no tiene mas filas (ej. cambio de datos a mitad de la
        // carga) no se queda en un bucle infinito pidiendo lo mismo una y otra vez
        if (page.length === 0) break;
        accumulated.push(...page);
        offset += page.length;
        setHistoryLoadProgress({ loaded: accumulated.length, total });
      }

      setHistoryPoints(accumulated);
      renderHistoryRoute(accumulated);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error obteniendo el historial');
    } finally {
      setHistoryLoadProgress(null);
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
    historyLoadProgress,
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
