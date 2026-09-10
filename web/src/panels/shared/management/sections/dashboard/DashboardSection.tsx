import { createSocket } from '@gaga-gps/client';
import { useEquipmentLayer, useGeofenceLayer, useSatelliteLayers } from '@gaga-gps/map-core';
import { MapModeSelector, VehicleDetailPanel } from '@gaga-gps/ui';
import type MapboxDraw from '@mapbox/mapbox-gl-draw';
import type maplibregl from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toGeofence } from '../../geofenceMapper';
import { useAdminAuth } from '../../useAdminAuth';
import { DashboardStats } from './components/DashboardStats';
import { DashboardToolbar, type Overlay } from './components/DashboardToolbar';
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

  const mapsAdmin = useMapsAdmin({ scope, isAdmin });

  const dashboardMap = useDashboardMap({
    scope,
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
    geofencesAdmin.loadGeofences();
    equipmentAdmin.loadEquipment();
    mapsAdmin.loadMaps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const socket = createSocket();
    socket.on('maps:active_update', () => mapsAdmin.loadMaps());
    return () => {
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    geofencesAdmin.setGeoShape('polygon');
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
    <>
      <div className="dash-map-bg">
        <div ref={dashboardMap.containerRef} style={{ width: '100%', height: '100%' }} />
      </div>

      <DashboardToolbar
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
      />

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

      {dashboardMap.detail && (
        <VehicleDetailPanel
          vehicle={dashboardMap.detail}
          offline={dashboardMap.detailOffline}
          operatorSession={dashboardMap.activeSession}
          appVersion={dashboardMap.detailAppVersion}
          onClose={() => dashboardMap.setSelectedVehicle(null)}
        />
      )}
    </>
  );
}
