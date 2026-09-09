import { VehicleCard } from '@gaga-gps/ui';
import type { FleetVehicle } from '../useSupervisorSocket';

const OFFLINE_THRESHOLD_MS = 45000;

export interface VehicleListPanelProps {
  vehicles: FleetVehicle[];
  now: Date;
  onSelect: (deviceId: string) => void;
}

export function VehicleListPanel({ vehicles, now, onSelect }: VehicleListPanelProps) {
  return (
    <div className="sup-vehicle-panel sup-glass">
      <div className="sup-section-header">Vehículos registrados</div>
      <div className="sup-vehicle-list">
        {vehicles.map((v) => {
          const isOffline = now.getTime() - v.lastSeen > OFFLINE_THRESHOLD_MS;
          return (
            <VehicleCard
              key={v.deviceId}
              name={v.deviceName || `Vehículo ${v.deviceId}`}
              type={v.deviceType}
              status={isOffline ? 'offline' : 'online'}
              hasAlert={isOffline}
              info={`${v.speed ? Math.round(v.speed * 3.6) : 0} km/h  |  ${v.latitude?.toFixed(5)}, ${v.longitude?.toFixed(5)}`}
              onClick={() => onSelect(v.deviceId)}
            />
          );
        })}
      </div>
    </div>
  );
}
