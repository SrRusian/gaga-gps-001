import { createSocket } from '@gaga-gps/client';
import type { GagaSocket } from '@gaga-gps/client';
import { useEquipmentLayer, useGeofenceLayer, useSatelliteLayers } from '@gaga-gps/map-core';
import { MapModeSelector, VehicleDetailPanel } from '@gaga-gps/ui';
import type MapboxDraw from '@mapbox/mapbox-gl-draw';
import type maplibregl from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toGeofence } from '../../geofenceMapper';
import { useAdminAuth } from '../../useAdminAuth';
import { useAlertsFeed } from '../../../hooks/useAlertsFeed';
import { AlertsModal } from './components/AlertsModal';
import { DashboardStats } from './components/DashboardStats';
import { DashboardSidebar, type Overlay } from './components/DashboardSidebar';
import { DevicesModal } from './components/DevicesModal';
import { EquipmentModal } from './components/EquipmentModal';
import { EquipmentPlacePanel } from './components/EquipmentPlacePanel';
import { GeofenceDrawPanel } from './components/GeofenceDrawPanel';
import { GeofencesModal } from './components/GeofencesModal';
import { HistoryFilterBar } from './components/HistoryFilterBar';
import { HistoryPlayback } from './components/HistoryPlayback';
import { MapsModal } from './components/MapsModal';
import { ProjectsModal } from './components/ProjectsModal';
import { ShiftsModal } from './components/ShiftsModal';
import { UsersModal } from './components/UsersModal';
import type { Scope } from './scope';
import { useDashboardMap } from './useDashboardMap';
import { useDevicesAdmin } from './useDevicesAdmin';
import { useEquipmentAdmin } from './useEquipmentAdmin';
import { useGeofencesAdmin } from './useGeofencesAdmin';
import { useHistoryMode } from './useHistoryMode';
import { useMapDrawing } from './useMapDrawing';
import { useMapsAdmin } from './useMapsAdmin';
import { useProjectsAdmin } from './useProjectsAdmin';
import { useShiftsAdmin } from './useShiftsAdmin';
import { useUsersAdmin } from './useUsersAdmin';
import { useVehicleTypesAdmin } from './useVehicleTypesAdmin';

// Orquestador del panel de Dashboard (Admin global + Administrador de Proyecto, ver
// panels/admin/index.tsx y panels/project-administrator/index.tsx) - conecta los hooks de cada
// recurso (uno por archivo en este mismo directorio) con los componentes de presentación en
// components/. Ningún hook de recurso conoce a los demás directamente; este archivo es el único
// que sabe cómo se conectan (ej. borrar un proyecto recarga usuarios/dispositivos/geocercas/
// equipo/mapas, borrar un dispositivo vinculado recarga equipo, etc).
export function DashboardSection() {
  const { user: me } = useAdminAuth();
  const isAdmin = me.role === 'admin';

  const [selectedProjectId, setSelectedProjectId] = useState<string>('global');
  const [activeOverlay, setActiveOverlay] = useState<Overlay>(null);
  const [historyMode, setHistoryMode] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('gaga_admin_sidebar') === 'collapsed';
    } catch {
      return false;
    }
  });

  function toggleSidebar() {
    setSidebarCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem('gaga_admin_sidebar', next ? 'collapsed' : 'expanded');
      } catch {
        // localStorage no disponible - se queda solo en memoria
      }
      return next;
    });
  }

  const scope: Scope = isAdmin
    ? selectedProjectId === 'global' || selectedProjectId === ''
      ? 'global'
      : Number(selectedProjectId)
    : (me.projectId ?? 'global');

  // 3 refs compartidos entre Geocercas/Equipo y el click handler del mapa (useMapDrawing) - ver
  // comentario en useGeofencesAdmin/useEquipmentAdmin sobre por que no pueden vivir en esos hooks
  const drawRef = useRef<MapboxDraw | null>(null);
  const circleMarkerRef = useRef<maplibregl.Marker | null>(null);
  const equipmentMarkerRef = useRef<maplibregl.Marker | null>(null);

  const projectsAdmin = useProjectsAdmin({
    onProjectDeleted: (deletedId) => {
      if (selectedProjectId === String(deletedId)) setSelectedProjectId('global');
      usersAdmin.loadUsers();
      devicesAdmin.loadDevices();
      geofencesAdmin.loadGeofences();
      equipmentAdmin.loadEquipment();
      mapsAdmin.loadMaps();
    },
  });
  const projects = projectsAdmin.projects;
  const scopeLabel =
    scope === 'global' ? 'Global' : (projects.find((p) => p.id === scope)?.name ?? `Proyecto #${scope}`);

  const usersAdmin = useUsersAdmin({ scope, isAdmin });
  const shiftsAdmin = useShiftsAdmin({ scope, isAdmin, allUsers: usersAdmin.allUsers });

  // orden de estos hooks importa: devicesAdmin no depende de equipmentAdmin (deleteDevice recibe
  // findLinkedEquipmentName como argumento en el momento del click, no como dependencia del hook -
  // ver useDevicesAdmin), asi que puede ir antes; equipmentAdmin si necesita el resultado de
  // devicesAdmin (allDevices) y de dashboardMap (map), por eso va despues de ambos.
  const devicesAdmin = useDevicesAdmin({
    scope,
    isAdmin,
    onDeviceDeleted: (_deviceUniqueId, hadLinkedEquipment) => {
      if (hadLinkedEquipment) equipmentAdmin.loadEquipment();
    },
  });
  const vehicleTypesAdmin = useVehicleTypesAdmin();

  const mapsAdmin = useMapsAdmin({ scope, isAdmin });

  const dashboardMap = useDashboardMap({
    scopedDevices: devicesAdmin.scopedDevices,
    historyMode,
    hasMaps: mapsAdmin.scopedActiveMaps.length > 0,
  });

  const equipmentAdmin = useEquipmentAdmin({
    map: dashboardMap.map,
    scope,
    allDevices: devicesAdmin.allDevices,
    equipmentMarkerRef,
    onDeviceLinked: () => devicesAdmin.loadDevices(),
  });

  const geofencesAdmin = useGeofencesAdmin({ map: dashboardMap.map, scope, drawRef, circleMarkerRef });

  const history = useHistoryMode({
    map: dashboardMap.map,
    scope,
    historyMode,
    setHistoryMode,
  });

  useMapDrawing({
    map: dashboardMap.map,
    loaded: dashboardMap.loaded,
    drawRef,
    circleMarkerRef,
    geofence: geofencesAdmin,
    equipment: equipmentAdmin,
  });

  // carga inicial de todo - una sola vez
  useEffect(() => {
    projectsAdmin.loadProjects();
    usersAdmin.loadUsers();
    devicesAdmin.loadDevices();
    vehicleTypesAdmin.loadVehicleTypes();
    geofencesAdmin.loadGeofences();
    equipmentAdmin.loadEquipment();
    mapsAdmin.loadMaps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [socket, setSocket] = useState<GagaSocket | null>(null);

  useEffect(() => {
    const s = createSocket();
    setSocket(s);
    s.on('maps:active_update', () => mapsAdmin.loadMaps());
    // reemplaza el poll REST de 7s que useDashboardMap tenía antes - bug real reportado: la
    // "última actualización" del detalle de vehículo se sentía cada ~8s en vez de cada 1s real
    // como ya funcionaba en Supervisor (que ya usa este mismo mecanismo de socket)
    s.on('fleet:update', (data) => dashboardMap.applyFleetUpdate(data.positions));
    return () => {
      s.disconnect();
      setSocket(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // mismo socket de arriba, nunca uno segundo - Admin (global) antes no tenia ninguna visibilidad
  // de alertas de seguridad (parada preventiva, colision, señal perdida, incidentes), pedido
  // explicito del usuario para que el panel global vea lo mismo que ya ve Supervisor
  const alertsFeed = useAlertsFeed(socket);

  const geofencesForLayer = useMemo(
    () => geofencesAdmin.scopedGeofences.map(toGeofence),
    [geofencesAdmin.scopedGeofences],
  );
  useGeofenceLayer(dashboardMap.map, dashboardMap.loaded, geofencesForLayer);
  useEquipmentLayer(
    dashboardMap.map,
    dashboardMap.loaded,
    historyMode ? [] : equipmentAdmin.equipmentForLayer,
  );
  useSatelliteLayers(dashboardMap.map, dashboardMap.loaded, mapsAdmin.scopedActiveMaps, dashboardMap.mapMode);

  const onlineCount = devicesAdmin.scopedDevices.filter((d) => d.status === 'online').length;
  const hasMaps = mapsAdmin.scopedActiveMaps.length > 0;

  function selectScope(next: string) {
    setSelectedProjectId(next);
    setActiveOverlay(null);
  }

  function openCreateGeofence() {
    geofencesAdmin.resetGeofenceForm();
    // onShapeChange (no setGeoShape crudo) - tambien entra a draw_polygon en MapboxDraw. Bug real
    // reportado: como 'polygon' ya es el shape default, el <select> de Forma nunca disparaba su
    // onChange al abrir el panel, así que el mapa se quedaba en simple_select y los clics no
    // creaban vertices - solo cambiar a Línea/corredor (que sí dispara onShapeChange) funcionaba.
    geofencesAdmin.onShapeChange('polygon');
    setActiveOverlay(null);
    geofencesAdmin.setShowGeoPanel(true);
  }

  function editGeofence(id: number) {
    const g = geofencesAdmin.scopedGeofences.find((row) => row.id === id);
    if (!g) return;
    setActiveOverlay(null);
    geofencesAdmin.editGeofenceRow(g);
  }

  function openCreateEquipment() {
    setActiveOverlay(null);
    equipmentAdmin.setShowEquipPanel(true);
  }

  function editEquipment(id: number) {
    const eq = equipmentAdmin.scopedEquipment.find((row) => row.id === id);
    if (!eq) return;
    setActiveOverlay(null);
    equipmentAdmin.editEquipmentRow(eq);
  }

  return (
    <div className="dash-layout">
      <DashboardSidebar
        isAdmin={isAdmin}
        scope={scope}
        scopeLabel={scopeLabel}
        selectedProjectId={selectedProjectId}
        projects={projects}
        onSelectScope={selectScope}
        onCreateProject={projectsAdmin.openCreateProject}
        activeOverlay={activeOverlay}
        onOpenOverlay={setActiveOverlay}
        historyMode={historyMode}
        onEnterHistoryMode={history.enterHistoryMode}
        onExitHistoryMode={history.exitHistoryMode}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebar}
        alertCount={alertsFeed.alertCount}
      />

      <div className="dash-map-area">
        <div className="dash-map-bg">
          <div ref={dashboardMap.containerRef} style={{ width: '100%', height: '100%' }} />
        </div>

        {historyMode && (
          <HistoryFilterBar
            scopedDevices={devicesAdmin.scopedDevices}
            historyDeviceId={history.historyDeviceId}
            setHistoryDeviceId={history.setHistoryDeviceId}
            historyFrom={history.historyFrom}
            setHistoryFrom={history.setHistoryFrom}
            historyTo={history.historyTo}
            setHistoryTo={history.setHistoryTo}
            onSearch={history.loadHistoryPoints}
            onExportCsv={history.exportHistoryCsv}
            csvExporting={history.csvExporting}
          />
        )}

        <DashboardStats
          deviceCount={devicesAdmin.scopedDevices.length}
          onlineCount={onlineCount}
          geofenceCount={geofencesAdmin.scopedGeofences.length}
          equipmentCount={equipmentAdmin.scopedEquipment.length}
        />

        <div className="dash-right-stack">
          <MapModeSelector mode={dashboardMap.mapMode} onChange={dashboardMap.setMapMode} satelliteAvailable={hasMaps} />

          {!hasMaps && (
            <div className="gg-no-maps-banner">
              <span>
                No hay ningún mapa satelital importado todavía para {scopeLabel} - los modos
                Satelital/Mixto no mostrarán nada (Calles sigue disponible).
              </span>
            </div>
          )}

          <GeofenceDrawPanel scope={scope} projects={projects} geofence={geofencesAdmin} />
          <EquipmentPlacePanel scope={scope} projects={projects} equipment={equipmentAdmin} />
        </div>

        <HistoryPlayback
          historyMode={historyMode}
          historyPoints={history.historyPoints}
          historySliderIndex={history.historySliderIndex}
          setHistorySliderIndex={history.setHistorySliderIndex}
          historyPlaying={history.historyPlaying}
          onTogglePlayback={history.toggleHistoryPlayback}
          showHistoryPanel={history.showHistoryPanel}
          setShowHistoryPanel={history.setShowHistoryPanel}
        />
      </div>

      <ProjectsModal
        open={activeOverlay === 'projects'}
        onClose={() => setActiveOverlay(null)}
        admin={projectsAdmin}
        onSelectScope={selectScope}
      />

      <ShiftsModal
        open={activeOverlay === 'shifts'}
        onClose={() => setActiveOverlay(null)}
        scopeLabel={scopeLabel}
        admin={shiftsAdmin}
      />

      <DevicesModal
        open={activeOverlay === 'devices'}
        onClose={() => setActiveOverlay(null)}
        scope={scope}
        scopeLabel={scopeLabel}
        isAdmin={isAdmin}
        projects={projects}
        findLinkedEquipmentName={equipmentAdmin.findLinkedEquipmentName}
        admin={devicesAdmin}
        vehicleTypesAdmin={vehicleTypesAdmin}
      />

      <UsersModal
        open={activeOverlay === 'users'}
        onClose={() => setActiveOverlay(null)}
        scope={scope}
        scopeLabel={scopeLabel}
        isAdmin={isAdmin}
        me={me}
        projects={projects}
        admin={usersAdmin}
      />

      <GeofencesModal
        open={activeOverlay === 'geofences'}
        onClose={() => setActiveOverlay(null)}
        scope={scope}
        scopeLabel={scopeLabel}
        projects={projects}
        admin={geofencesAdmin}
        onStartCreate={openCreateGeofence}
        onEdit={editGeofence}
      />

      <EquipmentModal
        open={activeOverlay === 'equipment'}
        onClose={() => setActiveOverlay(null)}
        scope={scope}
        scopeLabel={scopeLabel}
        projects={projects}
        admin={equipmentAdmin}
        onStartCreate={openCreateEquipment}
        onEdit={editEquipment}
      />

      <MapsModal
        open={activeOverlay === 'maps'}
        onClose={() => setActiveOverlay(null)}
        scope={scope}
        scopeLabel={scopeLabel}
        isAdmin={isAdmin}
        projects={projects}
        admin={mapsAdmin}
      />

      {isAdmin && (
        <AlertsModal
          open={activeOverlay === 'alerts'}
          onClose={() => setActiveOverlay(null)}
          alerts={alertsFeed.alerts}
          alertCount={alertsFeed.alertCount}
        />
      )}

      {dashboardMap.detail && (
        <VehicleDetailPanel
          vehicle={dashboardMap.detail}
          offline={dashboardMap.detailOffline}
          operatorSession={dashboardMap.activeSession}
          appVersion={dashboardMap.detailAppVersion}
          vehicleTypeName={dashboardMap.detailVehicleTypeName}
          onClose={() => dashboardMap.setSelectedVehicle(null)}
        />
      )}
    </div>
  );
}
