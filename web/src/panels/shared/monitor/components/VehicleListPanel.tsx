import { VehicleCard } from '@gaga-gps/ui';
import { NavIcon } from '../../components/NavIcons';
import type { FleetVehicle } from '../useSupervisorSocket';

const OFFLINE_THRESHOLD_MS = 45000;

export interface VehicleListPanelProps {
  vehicles: FleetVehicle[];
  now: Date;
  onSelect: (deviceId: string) => void;
  // nombre del tipo de vehículo asignado (ver vehicle_types) por deviceId - sin entrada = sin
  // tipo asignado, la tarjeta simplemente no muestra el "· <tipo>"
  vehicleTypeNamesById?: Record<string, string | null>;
}

export function VehicleListPanel({ vehicles, now, onSelect, vehicleTypeNamesById = {} }: VehicleListPanelProps) {
  return (
    <div className="sup-vehicle-panel sup-glass">
      <div className="sup-section-header sup-section-title">
        <NavIcon name="devices" size={14} />
        Vehículos registrados
      </div>
      <div className="sup-vehicle-list">
        {vehicles.map((v) => {
          const isOffline = now.getTime() - v.lastSeen > OFFLINE_THRESHOLD_MS;
          return (
            <VehicleCard
              key={v.deviceId}
              name={v.deviceName || `Vehículo ${v.deviceId}`}
              type={vehicleTypeNamesById[v.deviceId] ?? undefined}
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
