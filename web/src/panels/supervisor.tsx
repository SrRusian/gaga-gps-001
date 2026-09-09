import { roleLabel } from '@gaga-gps/client';
import { MapModeSelector, PanelHeader, VehicleDetailPanel } from '@gaga-gps/ui';
import { AlertsPanel } from './shared/monitor/components/AlertsPanel';
import { StopControlPanel } from './shared/monitor/components/StopControlPanel';
import { SupervisorStatsBar } from './shared/monitor/components/SupervisorStatsBar';
import { VehicleListPanel } from './shared/monitor/components/VehicleListPanel';
import { MapView } from './shared/monitor/MapView';
import './shared/monitor/supervisor.css';
import { useSupervisorScreen } from './shared/monitor/useSupervisorScreen';

// Supervisor de Proyecto (role=project_supervisor) - unico rol que ve StopControlPanel y puede
// resolver incidentes (onResolveIncident). project-manager.tsx arma el mismo layout sin
// esas dos piezas - ver panels/shared/monitor para lo que sí comparten.
export default function SupervisorPanel() {
  const s = useSupervisorScreen('gaga_supervisor_map_mode');

  return (
    <div className="sup-app">
      <PanelHeader
        connected={s.connected}
        userName={s.user.name}
        userRoleLabel={roleLabel(s.user.role)}
        onLogout={s.logout}
      />

      <main className="sup-float-main">
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

        <div className="sup-left-stack">
          <StopControlPanel
            stopStatus={s.stopStatus}
            onActivate={s.activateStop}
            onDeactivate={s.deactivateStop}
          />
          <AlertsPanel
            alerts={s.alerts}
            alertCount={s.alertCount}
            onResolveIncident={s.resolveIncident}
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

        {s.detail && (
          <VehicleDetailPanel
            vehicle={s.detail}
            offline={s.detailOffline}
            operatorSession={s.activeSession}
            onClose={s.closeVehicleDetail}
          />
        )}
      </main>
    </div>
  );
}
