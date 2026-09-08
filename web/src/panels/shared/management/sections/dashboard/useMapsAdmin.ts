import { getStoredToken } from '@gaga-gps/client';
import type { ActiveMap } from '@gaga-gps/shared-types';
import { useEffect, useMemo, useRef, useState } from 'react';
import { adminApi } from '../../api';
import type { MapRow } from '../../types';
import type { Scope } from './scope';

export const MAP_STATUS_LABEL: Record<string, string> = {
  processing: 'Procesando…',
  ready: 'Listo',
  failed: 'Error',
};

export const CRS_OPTIONS = [
  { value: 'EPSG:32611', label: 'UTM zona 11N (EPSG:32611)' },
  { value: 'EPSG:32612', label: 'UTM zona 12N (EPSG:32612)' },
  { value: 'EPSG:32613', label: 'UTM zona 13N (EPSG:32613)' },
  { value: 'EPSG:32614', label: 'UTM zona 14N (EPSG:32614)' },
  { value: 'EPSG:32615', label: 'UTM zona 15N (EPSG:32615)' },
  { value: 'EPSG:32616', label: 'UTM zona 16N (EPSG:32616)' },
  { value: 'EPSG:4326', label: 'WGS84 lat/lon (EPSG:4326)' },
];

export interface UseMapsAdminOptions {
  scope: Scope;
  isAdmin: boolean;
}

// XMLHttpRequest (no fetch) a proposito - es la unica forma con soporte amplio de exponer
// progreso real de subida (xhr.upload.onprogress), fetch no lo da de forma sencilla/confiable
function uploadMapFile(formData: FormData, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/maps');
    const token = getStoredToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      let message = `Error ${xhr.status}`;
      try {
        message = JSON.parse(xhr.responseText).error || message;
      } catch {
        // respuesta no era JSON - se queda el mensaje generico
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error('Error de red al subir el mapa'));
    xhr.send(formData);
  });
}

export function useMapsAdmin({ scope, isAdmin }: UseMapsAdminOptions) {
  const [mapsRows, setMapsRows] = useState<MapRow[]>([]);
  const [mapImportModal, setMapImportModal] = useState(false);
  const [mapImportForm, setMapImportForm] = useState({ name: '', crs: 'EPSG:32613', projectId: '' });
  const [mapImportError, setMapImportError] = useState('');
  // subida en curso, fuera del modal (que ya se cierra al iniciar) - se muestra como una fila mas
  // en la tabla de Mapas, con la misma seccion de estado que "Procesando"/"Listo"/"Error"
  const [mapUpload, setMapUpload] = useState<{ name: string; progress: number } | null>(null);
  const [mapEditModal, setMapEditModal] = useState<MapRow | null>(null);
  const [mapEditForm, setMapEditForm] = useState({ name: '', projectId: '' });
  const imageInputRef = useRef<HTMLInputElement>(null);
  const worldInputRef = useRef<HTMLInputElement>(null);
  const mapsPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function loadMaps() {
    const data = await adminApi.get<MapRow[]>('/api/maps');

    // setMapsRows(prev => ...) para comparar contra el estado mas reciente, no uno capturado
    // por el closure de este setInterval (que se crea una sola vez y no se refresca en cada render)
    setMapsRows((prev) => {
      data.forEach((m) => {
        const before = prev.find((p) => p.id === m.id);
        if (before?.status === 'processing' && m.status === 'failed') {
          alert(`No se pudo procesar el mapa "${m.name}":\n\n${m.error_message || 'Error desconocido'}`);
        }
      });
      return data;
    });

    const stillProcessing = data.some((m) => m.status === 'processing');
    if (stillProcessing && !mapsPollRef.current) {
      mapsPollRef.current = setInterval(loadMaps, 3000);
    } else if (!stillProcessing && mapsPollRef.current) {
      clearInterval(mapsPollRef.current);
      mapsPollRef.current = null;
    }
  }

  useEffect(() => {
    return () => {
      if (mapsPollRef.current) clearInterval(mapsPollRef.current);
    };
  }, []);

  const scopedMapsRows = useMemo(() => {
    if (scope === 'global') return mapsRows;
    if (typeof scope === 'number') return mapsRows.filter((m) => m.project_id === scope);
    return [];
  }, [mapsRows, scope]);

  const scopedActiveMaps: ActiveMap[] = useMemo(
    () =>
      scopedMapsRows
        .filter((m) => m.active && m.status === 'ready')
        .map((m) => ({
          id: m.id,
          name: m.name,
          tileUrlTemplate: `/tiles/maps/${m.id}/{z}/{x}/{y}.png`,
          bounds: m.bounds ?? null,
          minZoom: m.min_zoom,
          maxZoom: m.max_zoom,
        })),
    [scopedMapsRows],
  );

  async function importMap() {
    if (mapUpload) return;
    setMapImportError('');
    const effectiveProjectId =
      typeof scope === 'number' ? scope : mapImportForm.projectId ? Number(mapImportForm.projectId) : null;
    if (!effectiveProjectId) {
      setMapImportError('Selecciona un proyecto primero');
      return;
    }
    const imageFile = imageInputRef.current?.files?.[0];
    const worldFile = worldInputRef.current?.files?.[0];
    if (!mapImportForm.name.trim() || !imageFile || !worldFile) {
      setMapImportError('Completa nombre, imagen y world file');
      return;
    }

    const formData = new FormData();
    const mapName = mapImportForm.name.trim();
    formData.append('name', mapName);
    formData.append('sourceCrs', mapImportForm.crs);
    formData.append('projectId', String(effectiveProjectId));
    formData.append('image', imageFile);
    formData.append('worldFile', worldFile);

    // se cierra el modal y se limpia el formulario de inmediato - la subida sigue en segundo plano
    // (mapUpload) y el admin puede seguir usando el resto de la interfaz mientras tanto, en vez de
    // quedar atascado viendo un modal congelado hasta que termine en una red lenta
    setMapImportForm({ name: '', crs: 'EPSG:32613', projectId: '' });
    if (imageInputRef.current) imageInputRef.current.value = '';
    if (worldInputRef.current) worldInputRef.current.value = '';
    setMapImportModal(false);
    setMapUpload({ name: mapName, progress: 0 });

    try {
      await uploadMapFile(formData, (percent) => setMapUpload({ name: mapName, progress: percent }));
      loadMaps();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error importando el mapa');
    } finally {
      setMapUpload(null);
    }
  }

  async function activateMap(id: number) {
    if (
      !confirm('¿Activar este mapa? Se sumará como capa visible para Operador/Supervisor de este proyecto.')
    )
      return;
    await adminApi.post(`/api/maps/${id}/activate`);
    loadMaps();
  }

  async function deactivateMap(id: number) {
    if (!confirm('¿Desactivar este mapa? Dejará de verse en Operador/Supervisor.')) return;
    await adminApi.post(`/api/maps/${id}/deactivate`);
    loadMaps();
  }

  function openEditMap(m: MapRow) {
    setMapEditModal(m);
    setMapEditForm({ name: m.name, projectId: m.project_id != null ? String(m.project_id) : '' });
  }

  async function saveMapEdit() {
    if (!mapEditModal) return;
    const name = mapEditForm.name.trim();
    if (!name) {
      alert('El nombre es requerido');
      return;
    }
    try {
      const payload: { name: string; projectId?: number } = { name };
      // el selector de proyecto solo existe en el formulario para el admin global - si cambio,
      // se manda; para los demas roles el campo ni se renderiza, nunca se envia
      if (isAdmin && mapEditForm.projectId && Number(mapEditForm.projectId) !== mapEditModal.project_id) {
        payload.projectId = Number(mapEditForm.projectId);
      }
      await adminApi.patch(`/api/maps/${mapEditModal.id}`, payload);
      setMapEditModal(null);
      loadMaps();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error actualizando el mapa');
    }
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
      await adminApi.delete(`/api/maps/${m.id}`);
      loadMaps();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error eliminando el mapa');
    }
  }

  return {
    mapsRows,
    scopedMapsRows,
    scopedActiveMaps,
    mapImportModal,
    setMapImportModal,
    mapImportForm,
    setMapImportForm,
    mapImportError,
    mapUpload,
    mapEditModal,
    setMapEditModal,
    mapEditForm,
    setMapEditForm,
    imageInputRef,
    worldInputRef,
    loadMaps,
    importMap,
    activateMap,
    deactivateMap,
    openEditMap,
    saveMapEdit,
    deleteMapRow,
  };
}

export type MapsAdmin = ReturnType<typeof useMapsAdmin>;
