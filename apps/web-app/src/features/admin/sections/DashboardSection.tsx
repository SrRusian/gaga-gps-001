import { createSocket, getStoredToken, roleEntries, roleLabel } from '@gaga-gps/client';
import {
  circleToPolygon,
  EQUIPMENT_CORE_COLOR,
  EQUIPMENT_OUTER_COLOR,
  lineToBufferPolygon,
  shortVehicleLabel,
  useEquipmentLayer,
  useGeofenceLayer,
  useMapLibreMap,
  useMapMode,
  useSatelliteLayers,
} from '@gaga-gps/map-core';
import type { EquipmentMarkerData } from '@gaga-gps/map-core';
import { MapModeSelector, Modal, StatCard } from '@gaga-gps/ui';
import type { ActiveMap, Position } from '@gaga-gps/shared-types';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import type { Feature, FeatureCollection, LineString } from 'geojson';
import maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { adminApi } from '../api';
import { toGeofence } from '../geofenceMapper';
import type {
  DeviceRow,
  EquipmentRow,
  GeofenceRow,
  HistoryPoint,
  MapRow,
  ProjectRow,
  ShiftRow,
  UserRow,
} from '../types';
import { useAdminAuth } from '../useAdminAuth';


// Formato compacto para la tabla de detalle del historial -
// `toLocaleString()` (con sufijo "a. m./p. m." del locale) obligaba a
// la columna Fecha a envolver en 2-3 líneas incluso con la tabla ya
// ancha, forzando scroll horizontal por unos pixeles de más. 24h y
// sin año (el rango de búsqueda ya lo acota) - una sola línea corta.
function formatHistoryDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// "Global" es el estado inicial y por defecto para Admin - ve todo
// mezclado, como un supervisor de todo a la vez. Las dos pseudo-filas
// especiales ("Administradores globales" = usuarios sin proyecto,
// "Dispositivos sin asignar" = vehículos auto-registrados sin
// proyecto todavía) siguen existiendo para acotar rápido a ese caso
// puntual. Un Encargado de Proyecto nunca ve el selector - siempre es
// su propio proyecto, nunca "global".
type Scope = 'global' | number;
type Overlay =
  | 'projects'
  | 'shifts'
  | 'devices'
  | 'users'
  | 'geofences'
  | 'equipment'
  | 'maps'
  | null;
type GeofenceShape = 'circle' | 'polygon' | 'polyline';

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

// Estilo propio para MapboxDraw mientras se dibuja una geocerca nueva
// - el default de la librería (azul/naranja al 10% de opacidad, línea
// de 2px) se pierde contra el mapa (calles o satelital), sobre todo
// comparado con el color vívido que ya usa una geocerca guardada
// (`geofenceLayer.ts`). Mismos ids/filtros que el theme original de
// mapbox-gl-draw (necesarios para que cada capa siga aplicando al
// tipo de geometría/estado correcto) - solo cambia paint: relleno más
// opaco, línea más gruesa, y un halo blanco alrededor de cada punto
// para que se note incluso sobre imágenes satelitales oscuras.
const DRAW_COLOR = '#a855f7';
const DRAW_ACTIVE_COLOR = '#e879f9';
// Mismo morado que DRAW_COLOR - lo usa la previsualización en vivo de
// radio (círculo) y ancho de corredor (ruta) mientras se crea/edita,
// antes de guardar (ver PREVIEW_SOURCE_ID más abajo). Una sola
// constante para que "todavía no guardado" tenga un único color
// reconocible en todo el flujo de creación, sin importar la forma.
const PREVIEW_COLOR = DRAW_COLOR;
const PREVIEW_SOURCE_ID = 'geofence-draft-preview';

// Vista previa en vivo de equipo estático (radio de giro + radio de
// seguridad) mientras se crea/edita, antes de guardar - mismos
// colores que el equipo ya guardado (EQUIPMENT_CORE_COLOR/
// EQUIPMENT_OUTER_COLOR, `equipmentLayer.ts`) para que el color no
// "salte" al presionar Crear. El morado de geocercas nunca se usa
// aquí a propósito - amarillo núcleo + azul punteado exterior es una
// combinación que ninguna geocerca usa junto, así un equipo estático
// se distingue de una geocerca a simple vista incluso mientras se
// está dibujando/editando, no solo por tener dos anillos.
const EQUIP_PREVIEW_SOURCE_ID = 'equipment-draft-preview';
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

const CRS_OPTIONS = [
  { value: 'EPSG:32611', label: 'UTM zona 11N (EPSG:32611)' },
  { value: 'EPSG:32612', label: 'UTM zona 12N (EPSG:32612)' },
  { value: 'EPSG:32613', label: 'UTM zona 13N (EPSG:32613)' },
  { value: 'EPSG:32614', label: 'UTM zona 14N (EPSG:32614)' },
  { value: 'EPSG:32615', label: 'UTM zona 15N (EPSG:32615)' },
  { value: 'EPSG:32616', label: 'UTM zona 16N (EPSG:32616)' },
  { value: 'EPSG:4326', label: 'WGS84 lat/lon (EPSG:4326)' },
];

interface ProjectFormState {
  name: string;
}

interface ShiftFormState {
  name: string;
  startTime: string;
  endTime: string;
}

interface UserFormState {
  email: string;
  name: string;
  password: string;
  role: string;
  projectId: string;
}

interface DeviceFormState {
  uniqueId: string;
  name: string;
  type: string;
  projectId: string;
}

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

// Home único de Admin: mapa grande (geocercas + equipo estático +
// posiciones en vivo) con resumen de métricas arriba, exactamente
// como Supervisor pero para toda la operación - por defecto sin
// ningún proyecto elegido, es decir "Global" (todo mezclado). Elegir
// un proyecto específico acota el mapa/métricas a ese proyecto.
// Turnos/Dispositivos/Usuarios/Geocercas/Equipo/Mapas viven en
// overlays (Modal grande) que se abren bajo demanda desde la barra de
// herramientas, para no saturar la vista con todo siempre visible.
// Única excepción: *crear* una geocerca o colocar equipo necesita
// interacción real con el mapa (clic para centro/dibujo) - eso vive
// en un panel flotante sobre el mapa mismo, nunca dentro de un modal
// que lo taparía.
export function DashboardSection() {
  const { user: me } = useAdminAuth();
  const isAdmin = me.role === 'admin';

  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectSearch, setProjectSearch] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState<string>('global');
  const [activeOverlay, setActiveOverlay] = useState<Overlay>(null);

  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [allUsers, setAllUsers] = useState<UserRow[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [allDevices, setAllDevices] = useState<DeviceRow[]>([]);
  const [deviceSearch, setDeviceSearch] = useState('');
  const [allGeofences, setAllGeofences] = useState<GeofenceRow[]>([]);
  const [allEquipment, setAllEquipment] = useState<EquipmentRow[]>([]);
  const [mapsRows, setMapsRows] = useState<MapRow[]>([]);

  const [projectModal, setProjectModal] = useState<{ project?: ProjectRow } | null>(null);
  const [projectForm, setProjectForm] = useState<ProjectFormState>({ name: '' });

  const [shiftModal, setShiftModal] = useState<{ shift?: ShiftRow } | null>(null);
  const [shiftForm, setShiftForm] = useState<ShiftFormState>({
    name: '',
    startTime: '07:00',
    endTime: '15:00',
  });

  const [userModal, setUserModal] = useState<{ user?: UserRow } | null>(null);
  const [userForm, setUserForm] = useState<UserFormState>({
    email: '',
    name: '',
    password: '',
    role: 'operator',
    projectId: '',
  });

  const [deviceModal, setDeviceModal] = useState<{ device?: DeviceRow } | null>(null);
  const [deviceForm, setDeviceForm] = useState<DeviceFormState>({
    uniqueId: '',
    name: '',
    type: 'vehicle',
    projectId: '',
  });

  // ── Historial de recorridos - modo de vista, no overlay: mientras
  // está activo, el mapa grande de Dashboard deja de mostrar vehículos
  // en vivo/equipo estático y dibuja en cambio el recorrido histórico
  // elegido, conservando geocercas y mapas satelitales como
  // referencia (mismo mapa, no uno nuevo). ──
  const [historyMode, setHistoryMode] = useState(false);
  const [historyDeviceId, setHistoryDeviceId] = useState('');
  const [historyFrom, setHistoryFrom] = useState('');
  const [historyTo, setHistoryTo] = useState('');
  const [historyPoints, setHistoryPoints] = useState<HistoryPoint[]>([]);
  const [historySliderIndex, setHistorySliderIndex] = useState(0);
  const [historyPlaying, setHistoryPlaying] = useState(false);
  const [showHistoryPanel, setShowHistoryPanel] = useState(true);
  const historyMarkerRef = useRef<maplibregl.Marker | null>(null);
  const historyPlaybackRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Mapa grande ──────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const { map, loaded } = useMapLibreMap(containerRef, { center: [-103.7247, 19.2433], zoom: 12 });
  const [mapMode, setMapMode] = useMapMode('gaga_admin_dash_map_mode', 'streets');
  const drawRef = useRef<MapboxDraw | null>(null);
  const circleMarkerRef = useRef<maplibregl.Marker | null>(null);
  const equipmentMarkerRef = useRef<maplibregl.Marker | null>(null);
  const vehicleMarkersRef = useRef<Record<string, maplibregl.Marker>>({});

  const [showGeoPanel, setShowGeoPanel] = useState(false);
  const [geoShape, setGeoShape] = useState<GeofenceShape>('circle');
  const [geoSelectedCenter, setGeoSelectedCenter] = useState<{ lat: number; lon: number } | null>(
    null,
  );
  const [geoEditingId, setGeoEditingId] = useState<number | null>(null);
  const [geoTargetProjectId, setGeoTargetProjectId] = useState('');
  const [geofenceForm, setGeofenceForm] = useState<GeofenceFormState>({
    name: '',
    type: 'warning',
    radius: '',
    corridorWidth: '',
    corridorMargin: '',
  });
  const [selectedExportIds, setSelectedExportIds] = useState<Set<number>>(new Set());
  const [importFeedback, setImportFeedback] = useState<{ text: string; ok: boolean }>({
    text: '',
    ok: true,
  });
  const [geoImportModal, setGeoImportModal] = useState(false);
  const [geoImportProjectId, setGeoImportProjectId] = useState('');
  const geoImportFileRef = useRef<HTMLInputElement>(null);

  const [showEquipPanel, setShowEquipPanel] = useState(false);
  const [placingEquipment, setPlacingEquipment] = useState(false);
  const [equipTargetProjectId, setEquipTargetProjectId] = useState('');
  const [equipmentEditingId, setEquipmentEditingId] = useState<number | null>(null);
  const [equipmentPosition, setEquipmentPosition] = useState<{ lat: number; lon: number } | null>(
    null,
  );
  const [equipmentForm, setEquipmentForm] = useState<EquipmentFormState>({
    name: '',
    type: '',
    linkedDeviceId: '',
    swingRadius: '',
    safetyRadius: '',
  });

  const [mapImportModal, setMapImportModal] = useState(false);
  const [mapImportForm, setMapImportForm] = useState({ name: '', crs: 'EPSG:32613', projectId: '' });
  const [mapImportError, setMapImportError] = useState('');
  const imageInputRef = useRef<HTMLInputElement>(null);
  const worldInputRef = useRef<HTMLInputElement>(null);
  const mapsPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [livePositions, setLivePositions] = useState<Record<string, Position>>({});

  // Encargado de Proyecto: el "proyecto activo" siempre es el suyo,
  // nunca elige. Admin: lo que haya seleccionado arriba - "global" por
  // defecto (todo mezclado), como si fuera un supervisor de todo.
  const scope: Scope = isAdmin
    ? selectedProjectId === 'global' || selectedProjectId === ''
      ? 'global'
      : Number(selectedProjectId)
    : (me.projectId ?? 'global');

  // Un recorrido histórico pertenece a un proyecto específico - al
  // cambiar de proyecto (o volver a "Global", donde Historial ni
  // siquiera aparece) el modo se cierra y se limpia todo, en vez de
  // dejar dibujada la ruta de un proyecto distinto al elegido ahora.
  useEffect(() => {
    if (historyMode) exitHistoryMode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  async function loadProjects() {
    // GET /api/projects ya acepta admin y project_manager - Admin
    // recibe la lista completa, un Encargado solo el suyo (un array
    // de un elemento, filtrado del lado del servidor) - lo necesita
    // para resolver el nombre real de su proyecto (`scopeLabel`,
    // títulos de los overlays), no para administrar proyectos: crear/
    // editar/eliminar siguen exigiendo `admin` en el backend, y el
    // botón "+ Proyecto"/"Gestionar proyectos" del menú sigue oculto
    // para Encargado (ver `isAdmin ? (...) : (...)` del picker).
    try {
      setProjects(await adminApi.get<ProjectRow[]>('/api/projects'));
    } catch {
      setProjects([]);
    }
  }

  async function loadShifts() {
    if (typeof scope !== 'number') {
      setShifts([]);
      return;
    }
    const query = isAdmin ? `?projectId=${scope}` : '';
    setShifts(await adminApi.get<ShiftRow[]>(`/api/shifts${query}`));
  }

  async function loadUsers() {
    setAllUsers(await adminApi.get<UserRow[]>('/api/users'));
  }

  async function loadDevices() {
    setAllDevices(await adminApi.get<DeviceRow[]>('/api/devices'));
  }

  async function loadGeofences() {
    setAllGeofences(await adminApi.get<GeofenceRow[]>('/api/geofences'));
    setSelectedExportIds(new Set());
  }

  async function loadEquipment() {
    setAllEquipment(await adminApi.get<EquipmentRow[]>('/api/equipment'));
  }

  async function loadMaps() {
    // GET /api/maps ya acepta admin y project_manager (backend filtra
    // por req.user.projectId automáticamente) - mismo criterio que
    // geocercas/equipo/turnos, un Encargado tiene acceso completo pero
    // acotado a su propio proyecto. Sin projectId (Admin) trae todo -
    // así "Global" ya funciona sin caso especial.
    const data = await adminApi.get<MapRow[]>('/api/maps');
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
    loadProjects();
    loadUsers();
    loadDevices();
    loadGeofences();
    loadEquipment();
    loadMaps();
    return () => {
      if (mapsPollRef.current) clearInterval(mapsPollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- carga única al montar, no en cada render
  }, []);

  // Admin/Encargado no tienen ningún socket propio (a diferencia de
  // Supervisor/Operador) - todo lo demás en este componente se
  // refresca solo cuando la PROPIA pestaña hace una acción
  // (loadMaps() tras activar/importar/etc). Sin esto, un mapa
  // activado desde otra sesión (otra pestaña de Encargado, o Admin)
  // nunca aparecía sin recargar a mano - Supervisor sí lo veía en
  // vivo porque su socket ya escuchaba 'maps:active_update'. Vuelve a
  // pedir la lista completa por REST (no consume el payload del
  // evento directo) para que Admin/Encargado sigan viendo exactamente
  // lo que su propio scope de proyecto permite, ya resuelto del lado
  // del servidor - mismo criterio que loadMaps() en cualquier otro
  // punto de este archivo.
  useEffect(() => {
    const socket = createSocket();
    socket.on('maps:active_update', () => loadMaps());
    return () => {
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadMaps es estable en su forma, mismo criterio que el efecto de montaje de arriba
  }, []);

  useEffect(() => {
    loadShifts();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- se recarga a propósito solo cuando cambia el proyecto activo
  }, [scope]);

  // ── Posiciones en vivo - polling ligero de /api/fleet/state
  // (endpoint público que ya existe), Admin no tiene socket propio
  // hoy y no hace falta agregarle uno solo para esto. Corre siempre
  // (incluido "Global": todas las posiciones de todos los proyectos a
  // la vez).
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch('/api/fleet/state');
        const data = (await res.json()) as { positions: Position[] };
        if (cancelled) return;
        setLivePositions(Object.fromEntries(data.positions.map((p) => [p.deviceId, p])));
      } catch {
        // Silencioso - es solo un realce visual del mapa, no una acción crítica.
      }
    }
    poll();
    const interval = setInterval(poll, 7000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [scope]);

  const filteredProjects = useMemo(() => {
    if (!projectSearch.trim()) return projects;
    const q = projectSearch.trim().toLowerCase();
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, projectSearch]);

  const scopedUsers = useMemo(() => {
    const base = scope === 'global' ? allUsers : allUsers.filter((u) => u.project_id === scope);
    if (!userSearch.trim()) return base;
    const q = userSearch.trim().toLowerCase();
    return base.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  }, [allUsers, scope, userSearch]);

  const supervisorCandidates = useMemo(
    () => allUsers.filter((u) => u.role === 'project_supervisor' && u.project_id === scope),
    [allUsers, scope],
  );

  // Vehículos: se auto-registran solos desde la tableta (GET /gps con
  // un unique_id nuevo) sin proyecto asignado - se muestran primero
  // en la lista (en vez de tener un filtro dedicado "sin asignar")
  // para que sean fáciles de encontrar y asignar sin agregar una
  // opción más al selector de alcance. No dependen de ningún turno
  // para funcionar, permanecen en el proyecto y se reutilizan sin
  // importar quién esté de turno.
  const scopedDevices = useMemo(() => {
    let list = scope === 'global' ? allDevices : allDevices.filter((d) => d.project_id === scope);
    if (deviceSearch.trim()) {
      const q = deviceSearch.trim().toLowerCase();
      list = list.filter(
        (d) => d.name.toLowerCase().includes(q) || d.unique_id.toLowerCase().includes(q),
      );
    }
    return [...list].sort((a, b) => Number(a.project_id !== null) - Number(b.project_id !== null));
  }, [allDevices, scope, deviceSearch]);

  const scopedGeofences = useMemo(() => {
    if (scope === 'global') return allGeofences;
    if (typeof scope === 'number') return allGeofences.filter((g) => g.project_id === scope);
    return [];
  }, [allGeofences, scope]);
  const scopedEquipment = useMemo(() => {
    if (scope === 'global') return allEquipment;
    if (typeof scope === 'number') return allEquipment.filter((eq) => eq.project_id === scope);
    return [];
  }, [allEquipment, scope]);
  const scopedMapsRows = useMemo(() => {
    if (scope === 'global') return mapsRows;
    if (typeof scope === 'number') return mapsRows.filter((m) => m.project_id === scope);
    return [];
  }, [mapsRows, scope]);

  // Dispositivos elegibles para "Dispositivo vinculado" - del mismo
  // proyecto que el equipo (el propio, si se está editando en Global;
  // el elegido en el <select> de Proyecto, si se está creando en
  // Global) y que no estén ya vinculados a OTRO equipo (el índice
  // único parcial del backend lo rechazaría con 409 de todos modos,
  // pero es mejor no ofrecerlo desde el dropdown).
  const linkableDevices = useMemo(() => {
    const targetProjectId =
      typeof scope === 'number'
        ? scope
        : equipmentEditingId != null
          ? (allEquipment.find((e) => e.id === equipmentEditingId)?.project_id ?? null)
          : equipTargetProjectId
            ? Number(equipTargetProjectId)
            : null;
    if (targetProjectId == null) return [];
    const linkedElsewhere = new Set(
      allEquipment
        .filter((eq) => eq.linked_device_id && eq.id !== equipmentEditingId)
        .map((eq) => eq.linked_device_id),
    );
    return allDevices.filter(
      (d) => d.project_id === targetProjectId && !linkedElsewhere.has(d.unique_id),
    );
  }, [allDevices, allEquipment, scope, equipTargetProjectId, equipmentEditingId]);

  const geofencesForLayer = useMemo(() => scopedGeofences.map(toGeofence), [scopedGeofences]);
  const equipmentForLayer: EquipmentMarkerData[] = useMemo(
    () =>
      scopedEquipment.map((eq) => ({
        id: eq.id,
        name: eq.name,
        latitude: eq.latitude,
        longitude: eq.longitude,
        swingRadiusMeters: eq.swing_radius,
        safetyRadiusMeters: eq.safety_radius,
        linkedDeviceId: eq.linked_device_id,
      })),
    [scopedEquipment],
  );
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
  const scopedLivePositions = useMemo(() => {
    const ids = new Set(scopedDevices.map((d) => d.unique_id));
    return Object.values(livePositions).filter((p) => ids.has(p.deviceId));
  }, [livePositions, scopedDevices]);

  const hasMaps = scopedActiveMaps.length > 0;
  useEffect(() => {
    if (!hasMaps && mapMode !== 'streets') setMapMode('streets');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMaps]);

  useGeofenceLayer(map, loaded, geofencesForLayer);
  // En modo Historial se ocultan los anillos de equipo estático - solo
  // interesa el recorrido, las geocercas y los mapas satelitales
  // siguen igual (useGeofenceLayer/useSatelliteLayers sin cambios).
  useEquipmentLayer(map, loaded, historyMode ? [] : equipmentForLayer);
  useSatelliteLayers(map, loaded, scopedActiveMaps, mapMode);

  // Marcadores de vehículo en vivo - imperativos, igual que en
  // Supervisor/Operador (maplibregl.Marker no es JSX). En modo
  // Historial no se dibuja ninguno - el mapa muestra el recorrido, no
  // la flota en vivo.
  useEffect(() => {
    if (!map || !loaded) return;
    if (historyMode) {
      Object.keys(vehicleMarkersRef.current).forEach((id) => {
        vehicleMarkersRef.current[id].remove();
        delete vehicleMarkersRef.current[id];
      });
      return;
    }
    const currentIds = new Set(scopedLivePositions.map((p) => p.deviceId));
    Object.keys(vehicleMarkersRef.current).forEach((id) => {
      if (!currentIds.has(id)) {
        vehicleMarkersRef.current[id].remove();
        delete vehicleMarkersRef.current[id];
      }
    });
    scopedLivePositions.forEach((pos) => {
      const lngLat: [number, number] = [pos.longitude, pos.latitude];
      const existing = vehicleMarkersRef.current[pos.deviceId];
      if (existing) {
        existing.setLngLat(lngLat);
        return;
      }
      const el = document.createElement('div');
      el.className = 'dash-vehicle-marker';
      el.textContent = shortVehicleLabel(pos.deviceId);
      vehicleMarkersRef.current[pos.deviceId] = new maplibregl.Marker({ element: el })
        .setLngLat(lngLat)
        .addTo(map);
    });
  }, [map, loaded, scopedLivePositions, historyMode]);

  // ── Historial de recorridos ────────────────────────────────────
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

  // Segmentos coloreados por si el punto estaba dentro de alguna
  // geocerca (`zones.length > 0`) o no - mismo criterio visual que ya
  // usa el resto del panel para "dentro/fuera de zona autorizada".
  // Se agrega la fuente/capa la primera vez (nunca antes de que haya
  // algo que dibujar) y de ahí en más solo se actualiza con setData -
  // mismo patrón ya usado para PREVIEW_SOURCE_ID en geocercas, evita
  // mutar el estilo del mapa a medio uso.
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
      map!.fitBounds(
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
      // projectId explícito cuando hay un proyecto elegido - el
      // backend ya lo exige/valida (ver reports.routes.ts), esto solo
      // evita depender de que req.user.projectId alcance (Admin no
      // tiene uno propio).
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

  // El marcador de posición actual sigue al slider/reproducción -
  // el trazo dibujado en sí es estático, solo el marcador se mueve.
  useEffect(() => {
    const point = historyPoints[historySliderIndex];
    if (point && historyMarkerRef.current) {
      historyMarkerRef.current.setLngLat([point.longitude, point.latitude]);
    }
  }, [historySliderIndex, historyPoints]);

  useEffect(() => stopHistoryPlayback, []);

  // ── MapboxDraw + clic para geocerca circular / colocar equipo ────
  const geoShapeRef = useRef(geoShape);
  geoShapeRef.current = geoShape;
  const showGeoPanelRef = useRef(showGeoPanel);
  showGeoPanelRef.current = showGeoPanel;
  const placingEquipmentRef = useRef(placingEquipment);
  placingEquipmentRef.current = placingEquipment;

  // Previsualización en vivo de círculo/corredor mientras se crea o
  // edita una geocerca, ANTES de guardar - antes solo se veía el pin
  // del centro (círculo) o el trazo crudo de MapboxDraw (ruta), sin
  // ninguna referencia visual del radio/ancho real hasta crear. Se
  // recalcula tanto al escribir en el formulario (efecto de abajo)
  // como al mover un vértice del trazo (evento `draw.render`/
  // `draw.update` de MapboxDraw, mount effect) - por eso vive como
  // función imperativa (no un hook de capa como geofenceLayer.ts) en
  // vez de derivarse de un solo estado de React: necesita reaccionar
  // a dos fuentes de cambio distintas (formulario y geometría del
  // dibujo) sin volver a montar los listeners del mapa en cada
  // keystroke. `updateDraftPreviewRef` deja que los listeners
  // (agregados una sola vez al montar) siempre llamen a la versión
  // más reciente, con los valores de estado más recientes.
  const updateDraftPreviewRef = useRef<() => void>(() => {});

  // Crea la fuente/capas de previsualización UNA sola vez, vacías, al
  // montar el mapa - `updateDraftPreview` nunca vuelve a llamar
  // `addSource`/`addLayer` después de esto, solo `setData()`. Se
  // encontró en vivo que agregar una capa nueva a media sesión de
  // dibujo (la primera vez que había algo que previsualizar, ej. al
  // escribir el primer dígito del ancho de corredor) rompía la
  // detección de doble clic de mapbox-gl-draw para terminar una ruta/
  // polígono - agregar/mutar el estilo del mapa en medio de una
  // interacción de clics parece resetear el temporizador interno que
  // distingue un clic de un doble clic.
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

  // Mismo patrón que ensureDraftPreviewLayer (capa vacía registrada
  // una sola vez al montar, nunca vuelto a agregar después) - equipo
  // estático no interactúa con mapbox-gl-draw, pero se mantiene la
  // misma regla igual por consistencia y para no arriesgar una
  // mutación de estilo a destiempo si en el futuro se agrega algo más
  // aquí.
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

  // A diferencia de la previsualización de geocercas, esta no depende
  // de eventos de mapbox-gl-draw (equipo estático se coloca con un
  // clic simple/arrastre de marcador, siempre a través de React
  // state) - un useEffect normal alcanza, sin necesidad del patrón de
  // ref-a-última-versión.
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
  }, [
    showGeoPanel,
    geoShape,
    geoSelectedCenter,
    geofenceForm.radius,
    geofenceForm.corridorWidth,
    geofenceForm.corridorMargin,
  ]);

  useEffect(() => {
    if (!map || !loaded || drawRef.current) return;

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

    // Recalcula la previsualización del corredor a cada cambio del
    // trazo (agregar/mover/borrar un vértice) - `draw.render` es el
    // más frecuente de los tres pero el único que dispara también
    // durante el arrastre en vivo de un vértice, no solo al soltarlo.
    const handleDrawChange = () => updateDraftPreviewRef.current();
    map.on('draw.render', handleDrawChange);
    map.on('draw.update', handleDrawChange);

    // Al terminar de dibujar (doble clic, Enter, o el botón "Finalizar
    // trazado"), pasar directo a modo edición de vértices - así se
    // puede ajustar el trazo recién terminado (mover/agregar/quitar
    // vértices) antes de presionar "Crear", sin tener que saber que
    // existe un modo aparte para eso.
    //
    // El changeMode a direct_select NO puede llamarse de forma
    // síncrona aquí - draw.create se dispara desde dentro del propio
    // changeMode interno de mapbox-gl-draw (que ya pasa a simple_select
    // al terminar de dibujar), y reentrar con otro changeMode antes de
    // que ese ciclo termine de desenrollarse producía
    // "Maximum call stack size exceeded" (recursión infinita entre
    // onStop/fire/changeMode) y dejaba corrupto el detector interno de
    // doble clic para el siguiente dibujo. Diferir con setTimeout(0)
    // rompe esa reentrada - se ejecuta después de que mapbox-gl-draw
    // termina de procesar el evento actual, no durante.
    const handleDrawCreate = (e: { features?: { id?: string | number }[] }) => {
      updateDraftPreviewRef.current();
      const featureId = e.features?.[0]?.id;
      if (featureId != null) {
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
    // placeEquipmentMarker no entra a la dependencia a propósito - este
    // efecto solo corre una vez de verdad (el guard drawRef.current de
    // arriba lo bloquea en cualquier re-render posterior), y `map` ya
    // es la misma instancia estable para toda la vida del componente
    // (useMapLibreMap la fija una sola vez) - mismo criterio ya usado
    // en useMapLibreMap.ts para su propio efecto de montaje único.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, loaded]);

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

  // Alternativa explícita al doble clic para terminar polígono/ruta -
  // el doble clic (o doble-tap en tableta) no siempre es confiable en
  // pantalla táctil. changeMode('simple_select') es la misma
  // transición que mapbox-gl-draw hace internamente al detectar el
  // doble clic - dispara draw.create igual, sin duplicar lógica.
  function finishDrawing() {
    drawRef.current?.changeMode('simple_select');
  }

  const scopeLabel =
    scope === 'global' ? 'Global' : (projects.find((p) => p.id === scope)?.name ?? `Proyecto #${scope}`);

  // ── Proyectos ──────────────────────────────────────────────────
  function openCreateProject() {
    setProjectForm({ name: '' });
    setProjectModal({});
  }

  function openEditProject(p: ProjectRow) {
    setProjectForm({ name: p.name });
    setProjectModal({ project: p });
  }

  async function saveProject() {
    if (!projectForm.name.trim()) {
      alert('El nombre del proyecto es requerido');
      return;
    }
    try {
      if (projectModal?.project) {
        await adminApi.patch(`/api/projects/${projectModal.project.id}`, { name: projectForm.name });
      } else {
        await adminApi.post('/api/projects', { name: projectForm.name });
      }
      setProjectModal(null);
      loadProjects();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error guardando proyecto');
    }
  }

  async function toggleProjectActive(p: ProjectRow) {
    await adminApi.patch(`/api/projects/${p.id}`, { active: !p.active });
    loadProjects();
  }

  async function deleteProject(p: ProjectRow) {
    const typed = prompt(
      `Esta acción no se puede deshacer. Se eliminarán también sus turnos, geocercas, equipo ` +
        `estático, incidentes e historial de alertas. Sus usuarios se desactivarán y sus ` +
        `dispositivos quedarán sin proyecto asignado (ninguno de los dos se elimina). Para ` +
        `eliminar "${p.name}", escriba exactamente su nombre:`,
    );
    if (typed === null) return;
    if (typed !== p.name) {
      alert('El nombre no coincide - no se eliminó el proyecto');
      return;
    }
    try {
      await adminApi.delete(`/api/projects/${p.id}`);
      if (selectedProjectId === String(p.id)) setSelectedProjectId('global');
      loadProjects();
      loadUsers();
      loadDevices();
      loadGeofences();
      loadEquipment();
      loadMaps();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error eliminando proyecto');
    }
  }

  function selectScope(next: string) {
    setSelectedProjectId(next);
    setActiveOverlay(null);
  }

  // ── Turnos ─────────────────────────────────────────────────────
  function openCreateShift() {
    setShiftForm({ name: '', startTime: '07:00', endTime: '15:00' });
    setShiftModal({});
  }

  function openEditShift(s: ShiftRow) {
    setShiftForm({ name: s.name, startTime: s.start_time.slice(0, 5), endTime: s.end_time.slice(0, 5) });
    setShiftModal({ shift: s });
  }

  async function saveShift() {
    if (!shiftForm.name.trim()) {
      alert('El nombre del turno es requerido');
      return;
    }
    try {
      if (shiftModal?.shift) {
        await adminApi.patch(`/api/shifts/${shiftModal.shift.id}`, {
          name: shiftForm.name,
          startTime: `${shiftForm.startTime}:00`,
          endTime: `${shiftForm.endTime}:00`,
        });
      } else {
        await adminApi.post('/api/shifts', {
          name: shiftForm.name,
          startTime: `${shiftForm.startTime}:00`,
          endTime: `${shiftForm.endTime}:00`,
          projectId: typeof scope === 'number' ? scope : undefined,
        });
      }
      setShiftModal(null);
      loadShifts();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error guardando turno');
    }
  }

  async function assignSupervisor(shiftId: number, supervisorUserId: string) {
    await adminApi.patch(`/api/shifts/${shiftId}`, {
      supervisorUserId: supervisorUserId ? Number(supervisorUserId) : null,
    });
    loadShifts();
  }

  async function toggleShiftActive(s: ShiftRow) {
    await adminApi.patch(`/api/shifts/${s.id}`, { active: !s.active });
    loadShifts();
  }

  async function deleteShift(s: ShiftRow) {
    const typed = prompt(
      `Esta acción no se puede deshacer. Las sesiones de operador que ya trabajaron bajo este ` +
        `turno conservan su historial de horas - solo quedan sin turno asociado. Para eliminar ` +
        `"${s.name}", escriba exactamente su nombre:`,
    );
    if (typed === null) return;
    if (typed !== s.name) {
      alert('El nombre no coincide - no se eliminó el turno');
      return;
    }
    try {
      await adminApi.delete(`/api/shifts/${s.id}`);
      loadShifts();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error eliminando turno');
    }
  }

  // ── Usuarios ───────────────────────────────────────────────────
  function openCreateUser() {
    setUserForm({
      email: '',
      name: '',
      password: '',
      role: 'operator',
      projectId: '',
    });
    setUserModal({});
  }

  function openEditUser(u: UserRow) {
    setUserForm({
      email: u.email,
      name: u.name,
      password: '',
      role: u.role,
      projectId: u.project_id != null ? String(u.project_id) : '',
    });
    setUserModal({ user: u });
  }

  async function saveUser() {
    if (!userForm.email.trim() || !userForm.name.trim()) {
      alert('Email y nombre son requeridos');
      return;
    }
    try {
      if (userModal?.user) {
        await adminApi.patch(`/api/users/${userModal.user.id}`, {
          // Un Encargado solo puede tocar el rol (nunca email/nombre/
          // proyecto - ver los `disabled`/campos ocultos arriba, el
          // backend además lo exige del lado del servidor).
          ...(isAdmin ? { email: userForm.email, name: userForm.name } : {}),
          role: userForm.role,
          ...(isAdmin
            ? {
                projectId:
                  userForm.role === 'admin'
                    ? null
                    : userForm.projectId
                      ? Number(userForm.projectId)
                      : null,
              }
            : {}),
        });
      } else {
        if (!userForm.password) {
          alert('La contraseña es requerida');
          return;
        }
        const projectId =
          userForm.role === 'admin'
            ? null
            : scope === 'global'
              ? userForm.projectId
                ? Number(userForm.projectId)
                : null
              : scope;
        await adminApi.post('/api/users', { ...userForm, projectId });
      }
      setUserModal(null);
      loadUsers();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error guardando usuario');
    }
  }

  async function toggleUserActive(u: UserRow) {
    try {
      await adminApi.patch(`/api/users/${u.id}`, { active: !u.active });
      loadUsers();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error actualizando usuario');
    }
  }

  async function deleteUser(u: UserRow) {
    const typed = prompt(
      `Esta acción no se puede deshacer. Se eliminará también su historial de turnos de operador. ` +
        `Los turnos que supervisa y los incidentes que reportó/resolvió quedarán sin ese usuario ` +
        `asignado (no se eliminan). Para eliminar a "${u.name}", escriba exactamente su nombre:`,
    );
    if (typed === null) return;
    if (typed !== u.name) {
      alert('El nombre no coincide - no se eliminó el usuario');
      return;
    }
    try {
      await adminApi.delete(`/api/users/${u.id}?force=true`);
      loadUsers();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error eliminando usuario');
    }
  }

  // ── Dispositivos ───────────────────────────────────────────────
  function openCreateDevice() {
    setDeviceForm({ uniqueId: '', name: '', type: 'vehicle', projectId: '' });
    setDeviceModal({});
  }

  function openEditDevice(d: DeviceRow) {
    setDeviceForm({
      uniqueId: d.unique_id,
      name: d.name,
      type: d.type,
      projectId: d.project_id != null ? String(d.project_id) : '',
    });
    setDeviceModal({ device: d });
  }

  async function saveDevice() {
    if (!deviceForm.name.trim()) {
      alert('El nombre es requerido');
      return;
    }
    try {
      if (deviceModal?.device) {
        await adminApi.patch(`/api/devices/${deviceModal.device.id}`, {
          name: deviceForm.name,
          type: deviceForm.type,
          ...(isAdmin
            ? { projectId: deviceForm.projectId ? Number(deviceForm.projectId) : null }
            : {}),
        });
      } else {
        if (!deviceForm.uniqueId.trim()) {
          alert('El ID único (Traccar Client) es requerido');
          return;
        }
        const projectId =
          typeof scope === 'number'
            ? scope
            : deviceForm.projectId
              ? Number(deviceForm.projectId)
              : null;
        await adminApi.post('/api/devices', {
          uniqueId: deviceForm.uniqueId,
          name: deviceForm.name,
          type: deviceForm.type || 'vehicle',
          projectId,
        });
      }
      setDeviceModal(null);
      loadDevices();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error guardando dispositivo');
    }
  }

  async function deleteDevice(d: DeviceRow) {
    const linkedEquipment = allEquipment.find((eq) => eq.linked_device_id === d.unique_id);
    const linkedNote = linkedEquipment
      ? ` El equipo estático "${linkedEquipment.name}" que tiene vinculada esta tableta quedará sin dispositivo asignado (el equipo en sí no se elimina).`
      : '';
    const typed = prompt(
      `Esta acción no se puede deshacer. Se eliminará también todo su historial (posiciones, ` +
        `sensores, eventos de geocerca, incidentes reportados y alertas).${linkedNote} Para eliminar ` +
        `"${d.unique_id}", escriba exactamente su ID:`,
    );
    if (typed === null) return;
    if (typed !== d.unique_id) {
      alert('El ID no coincide - no se eliminó el dispositivo');
      return;
    }
    try {
      await adminApi.delete(`/api/devices/${d.id}?force=true`);
      loadDevices();
      if (linkedEquipment) loadEquipment();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error eliminando dispositivo');
    }
  }

  // ── Geocercas ──────────────────────────────────────────────────
  function resetGeofenceForm() {
    setGeoEditingId(null);
    setGeoTargetProjectId('');
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

  function editGeofenceRow(g: GeofenceRow) {
    if (!map) return;
    setActiveOverlay(null);
    setShowGeoPanel(true);
    setGeoEditingId(g.id);
    setGeoShape(g.shape_type);
    setGeofenceForm({
      name: g.name,
      type: g.type,
      radius: g.radius_meters != null ? String(g.radius_meters) : '',
      corridorWidth: g.corridor_width_meters != null ? String(g.corridor_width_meters) : '',
      corridorMargin:
        g.corridor_danger_margin_meters != null ? String(g.corridor_danger_margin_meters) : '',
    });
    drawRef.current?.deleteAll();
    if (g.shape_type === 'circle') {
      setGeoSelectedCenter({ lat: g.center_lat as number, lon: g.center_lon as number });
      if (circleMarkerRef.current) circleMarkerRef.current.remove();
      circleMarkerRef.current = new maplibregl.Marker()
        .setLngLat([g.center_lon as number, g.center_lat as number])
        .addTo(map);
      map.flyTo({ center: [g.center_lon as number, g.center_lat as number], zoom: 15 });
    } else if (g.geometry) {
      // "direct_select" (no el "simple_select" que deja mapbox-gl-draw
      // por default tras un `.add()`) es el modo que permite editar de
      // verdad - arrastrar cada vértice, agregar uno nuevo arrastrando
      // un punto medio, o borrarlo con Supr/Backspace - sin esto,
      // "editar" una geocerca de polígono/ruta solo servía para
      // cambiar nombre/tipo, no la forma en sí.
      const addedIds = drawRef.current?.add({ type: 'Feature', properties: {}, geometry: g.geometry });
      const featureId = addedIds?.[0];
      if (featureId != null) {
        drawRef.current?.changeMode('direct_select', { featureId: String(featureId) });
      }

      // Centrar/encuadrar el mapa en la geometría - editar una forma
      // que quedó fuera de la vista actual obligaría a buscarla a
      // mano antes de poder tocar un solo vértice.
      const coords =
        g.geometry.type === 'Polygon' ? g.geometry.coordinates[0] : g.geometry.coordinates;
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
          await adminApi[method](url, {
            name: geofenceForm.name,
            type: geofenceForm.type,
            shapeType: 'polygon',
            geometry,
            ...(isEditing ? {} : { projectId: effectiveProjectId }),
          });
        } else {
          const corridorWidthMeters = parseFloat(geofenceForm.corridorWidth);
          const corridorDangerMarginMeters = parseFloat(geofenceForm.corridorMargin) || null;
          if (!geofenceForm.name || !corridorWidthMeters) {
            alert('Complete nombre y ancho seguro del corredor');
            return;
          }
          await adminApi[method](url, {
            name: geofenceForm.name,
            type: geofenceForm.type,
            shapeType: 'polyline',
            geometry,
            corridorWidthMeters,
            corridorDangerMarginMeters,
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

  function toggleExportCheck(id: number, checked: boolean) {
    setSelectedExportIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function exportGeofences(format: 'geojson' | 'kml') {
    if (selectedExportIds.size === 0) {
      alert('Selecciona al menos una geocerca para exportar (marca su casilla).');
      return;
    }
    const ids = [...selectedExportIds].join(',');
    // Navegación real a la URL de descarga, no fetch() + blob: - Chrome
    // bloquea las descargas desde un blob: armado con JS en orígenes
    // sin HTTPS (mensaje "loaded over an insecure connection... should
    // be served over HTTPS"), aunque el archivo en sí no tenga nada
    // sensible; un <a href> a la URL real de red no cae en esa
    // restricción. Como un <a> no puede mandar un header Authorization,
    // el token va por query string (ver downloadAuthMiddleware).
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

  // El proyecto destino es la única pieza de información que un
  // GeoJSON/KML nunca trae - por eso vive en un modal chico (mismo
  // patrón que "Importar mapa satelital") en vez de pedirlo recién al
  // fallar el intento: con "Global" elegido, se pide explícitamente
  // antes de siquiera leer el archivo.
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
      setImportFeedback({
        ok: false,
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ── Equipo estático ────────────────────────────────────────────
  // Marcador arrastrable - mover un equipo ya colocado no requiere
  // volver a activar "Colocar en mapa", solo arrastrarlo. dragend
  // actualiza equipmentPosition (React state), que a su vez dispara
  // el useEffect de la vista previa y recalcula los dos anillos.
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
    setEquipTargetProjectId('');
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
    const effectiveProjectId =
      typeof scope === 'number' ? scope : equipTargetProjectId ? Number(equipTargetProjectId) : null;
    if (!isEditing && !effectiveProjectId) {
      alert('Selecciona un proyecto');
      return;
    }
    const swingRadius = parseFloat(equipmentForm.swingRadius);
    const safetyRadius = parseFloat(equipmentForm.safetyRadius);
    if (
      !equipmentForm.name ||
      !equipmentForm.type ||
      !equipmentPosition ||
      !swingRadius ||
      !safetyRadius
    ) {
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
        ...(isEditing ? {} : { projectId: effectiveProjectId }),
      };
      if (isEditing) {
        await adminApi.patch(`/api/equipment/${equipmentEditingId}`, payload);
      } else {
        await adminApi.post('/api/equipment', payload);
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
      await adminApi.delete(`/api/equipment/${eq.id}`);
      loadEquipment();
      if (eq.linked_device_id) loadDevices();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error eliminando el equipo');
    }
  }

  // ── Mapas ──────────────────────────────────────────────────────
  async function importMap() {
    setMapImportError('');
    const effectiveProjectId =
      typeof scope === 'number'
        ? scope
        : mapImportForm.projectId
          ? Number(mapImportForm.projectId)
          : null;
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
    formData.append('name', mapImportForm.name.trim());
    formData.append('sourceCrs', mapImportForm.crs);
    formData.append('projectId', String(effectiveProjectId));
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
      setMapImportForm({ name: '', crs: 'EPSG:32613', projectId: '' });
      if (imageInputRef.current) imageInputRef.current.value = '';
      if (worldInputRef.current) worldInputRef.current.value = '';
      setMapImportModal(false);
      loadMaps();
    } catch (err) {
      setMapImportError(err instanceof Error ? err.message : 'Error importando el mapa');
    }
  }

  async function activateMap(id: number) {
    if (
      !confirm(
        '¿Activar este mapa? Se sumará como capa visible para Operador/Supervisor de este proyecto.',
      )
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

  async function renameMap(id: number, currentName: string) {
    const name = prompt('Nuevo nombre:', currentName);
    if (!name) return;
    await adminApi.patch(`/api/maps/${id}`, { name });
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
      await adminApi.delete(`/api/maps/${m.id}`);
      loadMaps();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error eliminando el mapa');
    }
  }

  const onlineCount = scopedDevices.filter((d) => d.status === 'online').length;

  // Estilo Traccar: el mapa es el fondo de TODA la ventana
  // (position:fixed, detrás inclusive del header) y todo lo demás -
  // barra de herramientas, métricas, selector de modo, panel de
  // creación - flota encima como paneles independientes, no como
  // tarjetas apiladas en flujo normal. El selector de alcance solo
  // tiene "Global" y proyectos reales - no hace falta un filtro
  // dedicado para administradores/dispositivos sin proyecto: Global
  // ya los muestra sin filtrar, y los dispositivos sin proyecto se
  // listan primero dentro del overlay "Dispositivos" (ver
  // `scopedDevices`).
  return (
    <>
      <div className="dash-map-bg">
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      </div>

      <div className="dash-left-stack">
        <div className="dash-toolbar dash-glass">
          <div className="dash-scope-picker">
            {isAdmin ? (
              <>
                <select value={selectedProjectId} onChange={(e) => selectScope(e.target.value)}>
                  <option value="global">Global</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button className="btn btn-sm" onClick={openCreateProject}>
                  + Proyecto
                </button>
                <button className="btn btn-sm" onClick={() => setActiveOverlay('projects')}>
                  Gestionar proyectos
                </button>
              </>
            ) : (
              <span className="dash-scope-label">{scopeLabel}</span>
            )}
          </div>

          <div className="dash-actions">
            {typeof scope === 'number' && (
              <button className="btn btn-sm" onClick={() => setActiveOverlay('shifts')}>
                Turnos
              </button>
            )}
            <button className="btn btn-sm" onClick={() => setActiveOverlay('devices')}>
              Dispositivos
            </button>
            <button className="btn btn-sm" onClick={() => setActiveOverlay('users')}>
              Usuarios
            </button>
            <button className="btn btn-sm" onClick={() => setActiveOverlay('geofences')}>
              Geocercas
            </button>
            <button className="btn btn-sm" onClick={() => setActiveOverlay('equipment')}>
              Equipo estático
            </button>
            <button className="btn btn-sm" onClick={() => setActiveOverlay('maps')}>
              Mapas
            </button>
          </div>

          {/* Herramienta aparte, no un CRUD más - mismo separador que
              ya distingue el picker de proyecto de la lista de arriba.
              Mismo criterio de visibilidad que Turnos: un recorrido
              histórico pertenece a un proyecto, no tiene sentido en
              "Global". */}
          {typeof scope === 'number' && (
            <div className="dash-tools">
              <button
                className={`btn btn-sm${historyMode ? ' active' : ''}`}
                onClick={() => (historyMode ? exitHistoryMode() : enterHistoryMode())}
              >
                {historyMode ? 'Salir del historial' : 'Historial'}
              </button>
            </div>
          )}
        </div>
      </div>

      {historyMode && (
        <div className="dash-history-filter-bar dash-glass">
          <div className="dash-history-filter-field">
            <span className="dash-field-label">Dispositivo</span>
            <select value={historyDeviceId} onChange={(e) => setHistoryDeviceId(e.target.value)}>
              <option value="">Selecciona un dispositivo…</option>
              {scopedDevices.map((d) => (
                <option key={d.unique_id} value={d.unique_id}>
                  {d.name} ({d.unique_id})
                </option>
              ))}
            </select>
          </div>
          <div className="dash-history-filter-field">
            <span className="dash-field-label">Desde</span>
            <input
              type="datetime-local"
              value={historyFrom}
              onChange={(e) => setHistoryFrom(e.target.value)}
            />
          </div>
          <div className="dash-history-filter-field">
            <span className="dash-field-label">Hasta</span>
            <input
              type="datetime-local"
              value={historyTo}
              onChange={(e) => setHistoryTo(e.target.value)}
            />
          </div>
          <button className="btn btn-sm" onClick={loadHistoryPoints}>
            Buscar
          </button>
        </div>
      )}

      <div className="dash-bottom-left-stack">
        <div className="dash-stats dash-glass">
          <StatCard label="Dispositivos" value={scopedDevices.length} />
          <StatCard label="En línea" value={onlineCount} />
          <StatCard label="Geocercas" value={scopedGeofences.length} />
          <StatCard label="Equipo estático" value={scopedEquipment.length} />
        </div>
      </div>

      <div className="dash-right-stack">
        <MapModeSelector mode={mapMode} onChange={setMapMode} satelliteAvailable={hasMaps} />

        {!hasMaps && (
          <div className="gg-no-maps-banner">
            <span>
              No hay ningún mapa satelital importado todavía para {scopeLabel} - los modos
              Satelital/Mixto no mostrarán nada (Calles sigue disponible).
            </span>
          </div>
        )}

          {showGeoPanel && (
            <div className="dash-float-panel dash-glass">
              <div className="dash-float-panel-header">
                <h4>{geoEditingId != null ? 'Editar geocerca' : 'Nueva geocerca'}</h4>
                <button className="gg-modal-close" onClick={closeGeoPanel} aria-label="Cerrar">
                  X
                </button>
              </div>
              <div className="dash-float-panel-body">
                <div className="dash-field-group">
                  <span className="dash-field-group-title">Forma</span>
                  <select
                    value={geoShape}
                    onChange={(e) => onShapeChange(e.target.value as GeofenceShape)}
                    disabled={geoEditingId != null}
                  >
                    <option value="circle">Círculo</option>
                    <option value="polygon">Polígono (zona autorizada)</option>
                    <option value="polyline">Ruta / corredor autorizado</option>
                  </select>
                  <span className="dash-hint">{SHAPE_HINTS[geoShape]}</span>
                </div>

                {scope === 'global' && geoEditingId == null && (
                  <div className="dash-field-group">
                    <span className="dash-field-group-title">Proyecto</span>
                    <select
                      value={geoTargetProjectId}
                      onChange={(e) => setGeoTargetProjectId(e.target.value)}
                    >
                      <option value="">Selecciona un proyecto…</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="dash-field-group">
                  <span className="dash-field-group-title">Datos</span>
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
                  <div className="dash-field-group">
                    <span className="dash-field-group-title">Ubicación y radio</span>
                    <input
                      placeholder="Lat"
                      readOnly
                      value={geoSelectedCenter ? geoSelectedCenter.lat.toFixed(6) : ''}
                    />
                    <input
                      placeholder="Lon"
                      readOnly
                      value={geoSelectedCenter ? geoSelectedCenter.lon.toFixed(6) : ''}
                    />
                    <input
                      placeholder="Radio (m)"
                      type="number"
                      value={geofenceForm.radius}
                      onChange={(e) => setGeofenceForm({ ...geofenceForm, radius: e.target.value })}
                    />
                    {geoSelectedCenter && (
                      <span className="dash-hint">
                        Vista previa en morado sobre el mapa - se actualiza mientras escribes.
                      </span>
                    )}
                  </div>
                )}
                {geoShape === 'polyline' && (
                  <div className="dash-field-group">
                    <span className="dash-field-group-title">Ancho del corredor</span>
                    <input
                      placeholder="Ancho seguro (m)"
                      type="number"
                      value={geofenceForm.corridorWidth}
                      onChange={(e) =>
                        setGeofenceForm({ ...geofenceForm, corridorWidth: e.target.value })
                      }
                    />
                    <input
                      placeholder="Margen advertencia (m)"
                      type="number"
                      value={geofenceForm.corridorMargin}
                      onChange={(e) =>
                        setGeofenceForm({ ...geofenceForm, corridorMargin: e.target.value })
                      }
                    />
                    <span className="dash-hint">
                      Vista previa en morado sobre el mapa (franja segura + margen) - se actualiza
                      mientras escribes o mueves un vértice.
                    </span>
                  </div>
                )}
                <div className="dash-float-panel-actions">
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
            <div className="dash-float-panel dash-glass">
              <div className="dash-float-panel-header">
                <h4>{equipmentEditingId != null ? 'Editar equipo estático' : 'Nuevo equipo estático'}</h4>
                <button className="gg-modal-close" onClick={closeEquipPanel} aria-label="Cerrar">
                  X
                </button>
              </div>
              <div className="dash-float-panel-body">
                {scope === 'global' && equipmentEditingId == null && (
                  <div className="dash-field-group">
                    <span className="dash-field-group-title">Proyecto</span>
                    <select
                      value={equipTargetProjectId}
                      onChange={(e) => setEquipTargetProjectId(e.target.value)}
                    >
                      <option value="">Selecciona un proyecto…</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="dash-field-group">
                  <span className="dash-field-group-title">Datos</span>
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

                <div className="dash-field-group">
                  <span className="dash-field-group-title">Dispositivo vinculado</span>
                  <select
                    value={equipmentForm.linkedDeviceId}
                    onChange={(e) =>
                      setEquipmentForm({ ...equipmentForm, linkedDeviceId: e.target.value })
                    }
                  >
                    <option value="">Sin vincular</option>
                    {linkableDevices.map((d) => (
                      <option key={d.unique_id} value={d.unique_id}>
                        {d.name} ({d.unique_id})
                      </option>
                    ))}
                  </select>
                  <span className="dash-hint">
                    La tableta montada en esta máquina - cuando el operador inicie turno ahí, el
                    equipo pasa a "En operación" solo, y el operador se ve a sí mismo como este
                    equipo en vez de como vehículo.
                  </span>
                </div>

                <div className="dash-field-group">
                  <span className="dash-field-group-title">Ubicación y radios</span>
                  <button
                    className={`btn btn-sm${placingEquipment ? ' active' : ''}`}
                    onClick={() => setPlacingEquipment((v) => !v)}
                  >
                    {placingEquipment
                      ? 'Clic en el mapa…'
                      : equipmentPosition
                        ? 'Reubicar (clic en el mapa)'
                        : 'Colocar en mapa'}
                  </button>
                  <input
                    placeholder="Lat"
                    readOnly
                    value={equipmentPosition ? equipmentPosition.lat.toFixed(6) : ''}
                  />
                  <input
                    placeholder="Lon"
                    readOnly
                    value={equipmentPosition ? equipmentPosition.lon.toFixed(6) : ''}
                  />
                  <input
                    placeholder="Radio de giro (m)"
                    type="number"
                    value={equipmentForm.swingRadius}
                    onChange={(e) =>
                      setEquipmentForm({ ...equipmentForm, swingRadius: e.target.value })
                    }
                  />
                  <input
                    placeholder="Radio seguridad (m)"
                    type="number"
                    value={equipmentForm.safetyRadius}
                    onChange={(e) =>
                      setEquipmentForm({ ...equipmentForm, safetyRadius: e.target.value })
                    }
                  />
                  {equipmentPosition && (
                    <span className="dash-hint">
                      Vista previa en el mapa (núcleo amarillo = radio de giro, anillo punteado azul
                      = radio de seguridad) - se actualiza mientras escribes. Arrastra el marcador
                      para mover el equipo.
                    </span>
                  )}
                </div>

                <div className="dash-float-panel-actions">
                  <button className="btn btn-sm" onClick={saveEquipmentRow}>
                    {equipmentEditingId != null ? 'Guardar cambios' : 'Agregar'}
                  </button>
                </div>
              </div>
            </div>
          )}
      </div>

      {historyMode && historyPoints.length > 0 && (
        <div className="dash-history-playback dash-glass">
          <button className="btn btn-sm" onClick={toggleHistoryPlayback}>
            {historyPlaying ? 'Pausar' : 'Reproducir'}
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(0, historyPoints.length - 1)}
            value={historySliderIndex}
            onChange={(e) => setHistorySliderIndex(parseInt(e.target.value, 10))}
          />
          <span className="dash-history-playback-readout">
            {historyPoints[historySliderIndex]
              ? `${new Date(historyPoints[historySliderIndex].fix_time).toLocaleString()} · ${(historyPoints[historySliderIndex].speed * 3.6).toFixed(1)} km/h`
              : ''}
          </span>
        </div>
      )}

      {historyMode && historyPoints.length > 0 && (
        <button
          className={`dash-history-toggle${showHistoryPanel ? ' dash-history-toggle--open' : ' dash-history-toggle--closed'}`}
          onClick={() => setShowHistoryPanel((v) => !v)}
          title={showHistoryPanel ? 'Ocultar detalle' : 'Mostrar detalle'}
          aria-label={showHistoryPanel ? 'Ocultar detalle' : 'Mostrar detalle'}
        >
          {showHistoryPanel ? '>' : '<'}
        </button>
      )}

      {historyMode && (
        <div
          className={`dash-history-detail dash-glass${showHistoryPanel && historyPoints.length > 0 ? ' visible' : ''}`}
        >
          <div className="dash-history-detail-header">
            <h4>Detalle del recorrido</h4>
            <span className="dash-hint">
              {historyPoints.length
                ? `${historyPoints.filter((p) => p.zones.length > 0).length}/${historyPoints.length} puntos dentro de zona autorizada`
                : 'Sin datos en el rango seleccionado'}
            </span>
          </div>
          <div className="dash-history-detail-body">
            <table>
              <colgroup>
                <col style={{ width: '13%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '20%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Lat</th>
                  <th>Lon</th>
                  <th>Vel. (km/h)</th>
                  <th>Rumbo</th>
                  <th>Altitud (m)</th>
                  <th>Precisión (m)</th>
                  <th>Batería</th>
                  <th>Zona</th>
                </tr>
              </thead>
              <tbody>
                {historyPoints.map((p, i) => (
                  <tr
                    key={i}
                    className={`org-row${i === historySliderIndex ? ' selected' : ''}`}
                    onClick={() => setHistorySliderIndex(i)}
                  >
                    <td>{formatHistoryDateTime(p.fix_time)}</td>
                    <td>{p.latitude.toFixed(6)}</td>
                    <td>{p.longitude.toFixed(6)}</td>
                    <td>{(p.speed * 3.6).toFixed(1)}</td>
                    <td>{Math.round(p.course)}°</td>
                    <td>{Math.round(p.altitude)}</td>
                    <td>{Math.round(p.accuracy)}</td>
                    <td>{p.battery != null ? `${Math.round(p.battery)}%` : '-'}</td>
                    <td
                      className={p.zones.length ? 'zone-in' : 'zone-out'}
                      title={p.zones.length ? p.zones.map((z) => z.name).join(', ') : 'Fuera de zona'}
                    >
                      {p.zones.length ? p.zones.map((z) => z.name).join(', ') : 'Fuera de zona'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Overlays de gestión - se abren bajo demanda, no compiten
         por espacio con el mapa. ── */}

      <Modal
        size="large"
        open={activeOverlay === 'projects'}
        title="Proyectos"
        onClose={() => setActiveOverlay(null)}
      >
        <div className="dash-overlay-toolbar">
          <input
            placeholder="Buscar proyecto…"
            value={projectSearch}
            onChange={(e) => setProjectSearch(e.target.value)}
          />
          <button className="btn btn-sm" onClick={openCreateProject}>
            + Nuevo proyecto
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Activo</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr className="org-row" onClick={() => selectScope('global')}>
              <td>Global</td>
              <td>-</td>
              <td></td>
            </tr>
            {filteredProjects.map((p) => (
              <tr key={p.id} className="org-row" onClick={() => selectScope(String(p.id))}>
                <td>{p.name}</td>
                <td className={p.active ? 'status-online' : 'status-offline'}>{p.active ? 'Sí' : 'No'}</td>
                <td className="org-row-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="btn btn-sm" onClick={() => openEditProject(p)}>
                    Editar
                  </button>
                  <button className="btn btn-sm" onClick={() => toggleProjectActive(p)}>
                    {p.active ? 'Desactivar' : 'Activar'}
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => deleteProject(p)}>
                    Eliminar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Modal>

      <Modal
        size="large"
        open={activeOverlay === 'shifts'}
        title={`Turnos - ${scopeLabel}`}
        onClose={() => setActiveOverlay(null)}
      >
        <div className="dash-overlay-toolbar">
          <button className="btn btn-sm" onClick={openCreateShift}>
            + Nuevo turno
          </button>
        </div>
        {shifts.length === 0 ? (
          <div className="org-empty">Sin turnos todavía.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Horario</th>
                <th>Supervisor</th>
                <th>
                  <span className="dash-th-with-info">
                    Activo
                    <span
                      className="dash-info-icon"
                      title="Un turno inactivo se pausa temporalmente sin perder su configuración. Mientras esté así, el sistema no lo usa para asignar el turno de un operador que inicia sesión en ese horario. No indica si alguien está trabajando en este momento."
                    >
                      i
                    </span>
                  </span>
                </th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shifts.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>
                    {s.start_time.slice(0, 5)}-{s.end_time.slice(0, 5)}
                  </td>
                  <td>
                    <select
                      value={s.supervisor_user_id ?? ''}
                      onChange={(e) => assignSupervisor(s.id, e.target.value)}
                    >
                      <option value="">Sin asignar</option>
                      {supervisorCandidates.map((sup) => (
                        <option key={sup.id} value={sup.id}>
                          {sup.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td
                    className={s.active ? 'status-online' : 'status-offline'}
                    title="Indica si este horario se usa para asignar turnos automáticamente. No indica si alguien está trabajando en este momento."
                  >
                    {s.active ? 'Sí' : 'No'}
                  </td>
                  <td className="org-row-actions">
                    <button className="btn btn-sm" onClick={() => openEditShift(s)}>
                      Editar
                    </button>
                    <button className="btn btn-sm" onClick={() => toggleShiftActive(s)}>
                      {s.active ? 'Desactivar' : 'Activar'}
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => deleteShift(s)}>
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>

      <Modal
        size="large"
        open={activeOverlay === 'devices'}
        title={`Dispositivos - ${scopeLabel}`}
        onClose={() => setActiveOverlay(null)}
      >
        <div className="dash-overlay-toolbar">
          <input
            placeholder="Buscar…"
            value={deviceSearch}
            onChange={(e) => setDeviceSearch(e.target.value)}
          />
          {isAdmin && (
            <button className="btn btn-sm" onClick={openCreateDevice}>
              + Nuevo
            </button>
          )}
        </div>
        {scopedDevices.length === 0 ? (
          <div className="org-empty">Sin dispositivos todavía.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Nombre</th>
                <th>Tipo</th>
                {scope === 'global' && <th>Proyecto</th>}
                <th>Estado</th>
                <th>Equipo estático</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {scopedDevices.map((d) => (
                <tr key={d.id}>
                  <td>{d.unique_id}</td>
                  <td>{d.name}</td>
                  <td>{d.type}</td>
                  {scope === 'global' && (
                    <td>{projects.find((p) => p.id === d.project_id)?.name ?? 'Sin asignar'}</td>
                  )}
                  <td className={`status-${d.status}`}>{d.status}</td>
                  <td>{allEquipment.find((eq) => eq.linked_device_id === d.unique_id)?.name ?? '-'}</td>
                  <td className="org-row-actions">
                    <button className="btn btn-sm" onClick={() => openEditDevice(d)}>
                      Editar
                    </button>
                    {isAdmin && (
                      <button className="btn btn-sm btn-danger" onClick={() => deleteDevice(d)}>
                        Eliminar
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>

      <Modal
        size="large"
        open={activeOverlay === 'users'}
        title={`Usuarios - ${scopeLabel}`}
        onClose={() => setActiveOverlay(null)}
      >
        <div className="dash-overlay-toolbar">
          <input
            placeholder="Buscar…"
            value={userSearch}
            onChange={(e) => setUserSearch(e.target.value)}
          />
          {isAdmin && (
            <button className="btn btn-sm" onClick={openCreateUser}>
              + Nuevo
            </button>
          )}
        </div>
        {scopedUsers.length === 0 ? (
          <div className="org-empty">Sin usuarios todavía.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Nombre</th>
                <th>Rol</th>
                {scope === 'global' && <th>Proyecto</th>}
                <th>Activo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {scopedUsers.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.name}</td>
                  <td>{roleLabel(u.role)}</td>
                  {scope === 'global' && (
                    <td>{projects.find((p) => p.id === u.project_id)?.name ?? 'Sin proyecto'}</td>
                  )}
                  <td className={u.active ? 'status-online' : 'status-offline'}>
                    {u.active ? 'Sí' : 'No'}
                  </td>
                  <td className="org-row-actions">
                    <button className="btn btn-sm" onClick={() => openEditUser(u)}>
                      Editar
                    </button>
                    {/* Un Encargado no puede desactivarse a sí mismo -
                        se quedaría fuera de su propio proyecto sin
                        forma de volver a entrar (a diferencia de
                        Admin, que puede reactivarse con otra cuenta
                        admin si la hay). Mismo guard reforzado en el
                        backend, esto es solo para no ofrecer una
                        acción que el servidor va a rechazar. */}
                    {(isAdmin || u.id !== me.id) && (
                      <button className="btn btn-sm" onClick={() => toggleUserActive(u)}>
                        {u.active ? 'Desactivar' : 'Activar'}
                      </button>
                    )}
                    {isAdmin && (
                      <button className="btn btn-sm btn-danger" onClick={() => deleteUser(u)}>
                        Eliminar
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>

      <Modal
        size="large"
        open={activeOverlay === 'geofences'}
        title={`Geocercas - ${scopeLabel}`}
        onClose={() => setActiveOverlay(null)}
      >
        <div className="dash-overlay-toolbar">
          <button
            className="btn btn-sm"
            onClick={() => {
              setActiveOverlay(null);
              setShowGeoPanel(true);
            }}
          >
            + Nueva geocerca
          </button>
          <button className="btn btn-sm" onClick={() => exportGeofences('geojson')}>
            Exportar GeoJSON
          </button>
          <button className="btn btn-sm" onClick={() => exportGeofences('kml')}>
            Exportar KML
          </button>
          <button className="btn btn-sm" onClick={openGeoImportModal}>
            Importar (GeoJSON/KML)
          </button>
        </div>
        {scopedGeofences.length === 0 ? (
          <div className="org-empty">Sin geocercas todavía.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 24 }}>
                  <input
                    type="checkbox"
                    title="Seleccionar todas"
                    onChange={(e) =>
                      setSelectedExportIds(
                        e.target.checked ? new Set(scopedGeofences.map((g) => g.id)) : new Set(),
                      )
                    }
                  />
                </th>
                <th>Nombre</th>
                <th>Tipo</th>
                {scope === 'global' && <th>Proyecto</th>}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {scopedGeofences.map((g) => (
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
                  {scope === 'global' && (
                    <td>{projects.find((p) => p.id === g.project_id)?.name ?? '-'}</td>
                  )}
                  <td className="org-row-actions">
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

      <Modal
        size="large"
        open={activeOverlay === 'equipment'}
        title={`Equipo estático - ${scopeLabel}`}
        onClose={() => setActiveOverlay(null)}
      >
        <div className="dash-overlay-toolbar">
          <button
            className="btn btn-sm"
            onClick={() => {
              setActiveOverlay(null);
              setShowEquipPanel(true);
            }}
          >
            + Nuevo equipo
          </button>
        </div>
        {scopedEquipment.length === 0 ? (
          <div className="org-empty">Sin equipo estático todavía.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Tipo</th>
                {scope === 'global' && <th>Proyecto</th>}
                <th>Radio giro</th>
                <th>Radio seguridad</th>
                <th>Dispositivo</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {scopedEquipment.map((eq) => (
                <tr key={eq.id}>
                  <td>{eq.name}</td>
                  <td>{eq.type}</td>
                  {scope === 'global' && (
                    <td>{projects.find((p) => p.id === eq.project_id)?.name ?? '-'}</td>
                  )}
                  <td>{eq.swing_radius}</td>
                  <td>{eq.safety_radius}</td>
                  <td>
                    {eq.linked_device_id
                      ? (allDevices.find((d) => d.unique_id === eq.linked_device_id)?.name ??
                        eq.linked_device_id)
                      : '-'}
                  </td>
                  <td>
                    {eq.linked_device_id
                      ? eq.status === 'inactive'
                        ? 'Inactivo (sin turno)'
                        : 'En operación'
                      : eq.status}
                  </td>
                  <td className="org-row-actions">
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

      <Modal
        size="large"
        open={activeOverlay === 'maps'}
        title={`Mapas - ${scopeLabel}`}
        onClose={() => setActiveOverlay(null)}
      >
        <div className="dash-overlay-toolbar">
          <button className="btn btn-sm" onClick={() => setMapImportModal(true)}>
            + Importar mapa
          </button>
        </div>
        {scopedMapsRows.length === 0 ? (
          <div className="org-empty">Sin mapas importados todavía.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                {scope === 'global' && <th>Proyecto</th>}
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {scopedMapsRows.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.name}
                    {m.active && <span className="ad-badge">Activo</span>}
                  </td>
                  {scope === 'global' && (
                    <td>{projects.find((p) => p.id === m.project_id)?.name ?? '-'}</td>
                  )}
                  <td className={`status-${m.status}`} title={m.error_message || ''}>
                    {MAP_STATUS_LABEL[m.status] || m.status}
                  </td>
                  <td className="org-row-actions">
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

      {/* ── Modales chicos de alta/edición ── */}

      <Modal
        open={projectModal !== null}
        title={projectModal?.project ? 'Editar proyecto' : 'Nuevo proyecto'}
        onClose={() => setProjectModal(null)}
      >
        <div className="gg-modal-field">
          <label>Nombre</label>
          <input
            placeholder="ej. Mina Colima Norte"
            value={projectForm.name}
            onChange={(e) => setProjectForm({ name: e.target.value })}
          />
        </div>
        <div className="gg-modal-actions">
          <button className="btn btn-sm" onClick={() => setProjectModal(null)}>
            Cancelar
          </button>
          <button className="btn btn-sm" onClick={saveProject}>
            Guardar
          </button>
        </div>
      </Modal>

      <Modal
        open={shiftModal !== null}
        title={shiftModal?.shift ? 'Editar turno' : 'Nuevo turno'}
        onClose={() => setShiftModal(null)}
      >
        <div className="gg-modal-field">
          <label>Nombre</label>
          <input
            placeholder="ej. Matutino"
            value={shiftForm.name}
            onChange={(e) => setShiftForm({ ...shiftForm, name: e.target.value })}
          />
        </div>
        <div className="gg-modal-field">
          <label>Hora de inicio</label>
          <input
            type="time"
            value={shiftForm.startTime}
            onChange={(e) => setShiftForm({ ...shiftForm, startTime: e.target.value })}
          />
        </div>
        <div className="gg-modal-field">
          <label>Hora de fin</label>
          <input
            type="time"
            value={shiftForm.endTime}
            onChange={(e) => setShiftForm({ ...shiftForm, endTime: e.target.value })}
          />
        </div>
        <div className="gg-modal-actions">
          <button className="btn btn-sm" onClick={() => setShiftModal(null)}>
            Cancelar
          </button>
          <button className="btn btn-sm" onClick={saveShift}>
            Guardar
          </button>
        </div>
      </Modal>

      <Modal
        open={userModal !== null}
        title={userModal?.user ? 'Editar usuario' : 'Nuevo usuario'}
        onClose={() => setUserModal(null)}
      >
        <div className="gg-modal-field">
          <label>Email</label>
          <input
            value={userForm.email}
            disabled={!isAdmin}
            onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
          />
        </div>
        <div className="gg-modal-field">
          <label>Nombre</label>
          <input
            value={userForm.name}
            disabled={!isAdmin}
            onChange={(e) => setUserForm({ ...userForm, name: e.target.value })}
          />
        </div>
        {!userModal?.user && (
          <div className="gg-modal-field">
            <label>Contraseña</label>
            <input
              type="password"
              value={userForm.password}
              onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
            />
          </div>
        )}
        {/* Un Encargado SÍ puede editar el rol de los usuarios de su
            propio proyecto (a diferencia de email/nombre/proyecto,
            bloqueados arriba/abajo) - la única restricción real es que
            nunca puede asignar 'admin' (le daría a otra cuenta alcance
            global, ver el mismo guard reforzado en el backend). Como
            "+ Nuevo" ya está oculto para Encargado, este modal solo se
            abre para editar en su caso - no hace falta gate adicional
            aquí. */}
        <div className="gg-modal-field">
          <label>Rol</label>
          <select
            value={userForm.role}
            onChange={(e) => {
              const role = e.target.value;
              // Admin es alcance global por diseño (project_id = NULL
              // es el único caso válido en todo el sistema, ver
              // CLAUDE.md "Multi-tenencia por proyecto") - asignarle
              // un proyecto no tiene sentido y le quitaría permisos
              // en la práctica, así que se limpia de una vez al
              // cambiar a este rol.
              setUserForm({ ...userForm, role, projectId: role === 'admin' ? '' : userForm.projectId });
            }}
          >
            {roleEntries()
              .filter(([value]) => isAdmin || value !== 'admin')
              .map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
          </select>
        </div>
        {isAdmin && (userModal?.user || scope === 'global') && (
          <div className="gg-modal-field">
            <label>Proyecto</label>
            <select
              value={userForm.projectId}
              disabled={userForm.role === 'admin'}
              onChange={(e) => setUserForm({ ...userForm, projectId: e.target.value })}
            >
              <option value="">Sin proyecto (solo admin)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {userForm.role === 'admin' && (
              <span className="dash-hint">Un Admin siempre tiene alcance global - no se le puede asignar un proyecto.</span>
            )}
          </div>
        )}
        <div className="gg-modal-actions">
          <button className="btn btn-sm" onClick={() => setUserModal(null)}>
            Cancelar
          </button>
          <button className="btn btn-sm" onClick={saveUser}>
            Guardar
          </button>
        </div>
      </Modal>

      <Modal
        open={deviceModal !== null}
        title={deviceModal?.device ? 'Editar dispositivo' : 'Nuevo dispositivo'}
        onClose={() => setDeviceModal(null)}
      >
        {!deviceModal?.device && (
          <div className="gg-modal-field">
            <label>ID único (Traccar Client)</label>
            <input
              value={deviceForm.uniqueId}
              onChange={(e) => setDeviceForm({ ...deviceForm, uniqueId: e.target.value })}
            />
          </div>
        )}
        <div className="gg-modal-field">
          <label>Nombre</label>
          <input
            value={deviceForm.name}
            onChange={(e) => setDeviceForm({ ...deviceForm, name: e.target.value })}
          />
        </div>
        <div className="gg-modal-field">
          <label>Tipo</label>
          <input
            placeholder="vehicle"
            value={deviceForm.type}
            onChange={(e) => setDeviceForm({ ...deviceForm, type: e.target.value })}
          />
        </div>
        {isAdmin && (deviceModal?.device || scope === 'global') && (
          <div className="gg-modal-field">
            <label>Proyecto</label>
            <select
              value={deviceForm.projectId}
              onChange={(e) => setDeviceForm({ ...deviceForm, projectId: e.target.value })}
            >
              <option value="">Sin asignar</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="gg-modal-actions">
          <button className="btn btn-sm" onClick={() => setDeviceModal(null)}>
            Cancelar
          </button>
          <button className="btn btn-sm" onClick={saveDevice}>
            Guardar
          </button>
        </div>
      </Modal>

      <Modal
        open={geoImportModal}
        title="Importar geocercas (GeoJSON/KML)"
        onClose={() => setGeoImportModal(false)}
      >
        {scope === 'global' && (
          <div className="gg-modal-field">
            <label>Proyecto</label>
            <select
              value={geoImportProjectId}
              onChange={(e) => setGeoImportProjectId(e.target.value)}
            >
              <option value="">Selecciona un proyecto…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="gg-modal-field">
          <label>Archivo (.geojson / .json / .kml)</label>
          <input ref={geoImportFileRef} type="file" accept=".geojson,.json,.kml" />
        </div>
        {importFeedback.text && (
          <div style={{ fontSize: 12, color: importFeedback.ok ? '#4f8ff0' : '#e5484d' }}>
            {importFeedback.text}
          </div>
        )}
        <div className="gg-modal-actions">
          <button className="btn btn-sm" onClick={() => setGeoImportModal(false)}>
            Cancelar
          </button>
          <button className="btn btn-sm" onClick={importGeofences}>
            Importar
          </button>
        </div>
      </Modal>

      <Modal open={mapImportModal} title="Importar mapa satelital/drone" onClose={() => setMapImportModal(false)}>
        {scope === 'global' && (
          <div className="gg-modal-field">
            <label>Proyecto</label>
            <select
              value={mapImportForm.projectId}
              onChange={(e) => setMapImportForm({ ...mapImportForm, projectId: e.target.value })}
            >
              <option value="">Selecciona un proyecto…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
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
          <select
            value={mapImportForm.crs}
            onChange={(e) => setMapImportForm({ ...mapImportForm, crs: e.target.value })}
          >
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
}
