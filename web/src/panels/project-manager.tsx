import { roleLabel } from '@gaga-gps/client';
import { MapModeSelector, VehicleDetailPanel } from '@gaga-gps/ui';
import { AlertsPanel } from './shared/monitor/components/AlertsPanel';
import { MonitorShell } from './shared/monitor/components/MonitorShell';
import { SupervisorStatsBar } from './shared/monitor/components/SupervisorStatsBar';
import { VehicleListPanel } from './shared/monitor/components/VehicleListPanel';
import { MapView } from './shared/monitor/MapView';
import './shared/monitor/supervisor.css';
import { useSupervisorScreen } from './shared/monitor/useSupervisorScreen';

// Encargado de Proyecto (role=project_manager) - 100% solo lectura: mismo layout que
// panels/supervisor.tsx pero sin StopControlPanel y sin pasar onResolveIncident a
// AlertsPanel (el boton "Resolver" no se renderiza sin esa prop).
export default function ProjectManagerPanel() {
  const s = useSupervisorScreen('gaga_supervisor_map_mode');

  return (
    <MonitorShell
      connected={s.connected}
      userName={s.user.name}
      userRoleLabel={roleLabel(s.user.role)}
      onLogout={s.logout}
    >
      <div className="sup-layout">
        <aside className="sup-sidebar">
          <AlertsPanel alerts={s.alerts} alertCount={s.alertCount} />
        </aside>

        <div className="sup-map-area">
          <div className="sup-map-bg">
            <MapView
              ref={s.mapRef}
              fleet={s.fleet}
              geofences={s.geofences}
              incidents={s.incidents}
              equipment={s.equipment}
              activeMaps={s.activeMaps}
              mapMode={s.mapMode}
              selectedVehicleId={s.selectedVehicle}
              onVehicleClick={s.selectVehicle}
            />
          </div>

          <div className="sup-right-stack">
            <MapModeSelector mode={s.mapMode} onChange={s.setMapMode} satelliteAvailable={s.hasMaps} />

            {!s.hasMaps && (
              <div className="gg-no-maps-banner">
                <span>
                  No hay ningún mapa satelital importado todavía para tu proyecto - los modos
                  Satelital/Mixto no mostrarán nada (Calles sigue disponible).
                </span>
              </div>
            )}

            <VehicleListPanel vehicles={s.vehicles} now={s.now} onSelect={s.selectVehicle} />
          </div>

          <div className="sup-bottom-left-stack">
            <SupervisorStatsBar
              total={s.vehicles.length}
              online={s.onlineCount}
              alertCount={s.alertCount}
              offline={s.offlineCount}
            />
          </div>
        </div>
      </div>

      {s.detail && (
        <VehicleDetailPanel
          vehicle={s.detail}
          offline={s.detailOffline}
          operatorSession={s.activeSession}
          appVersion={s.detailAppVersion}
          onClose={s.closeVehicleDetail}
        />
      )}
    </MonitorShell>
  );
}
