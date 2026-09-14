import { StatCard } from '@gaga-gps/ui';
import { NavIcon } from '../../../components/NavIcons';

export interface DashboardStatsProps {
  deviceCount: number;
  onlineCount: number;
  geofenceCount: number;
  equipmentCount: number;
}

export function DashboardStats({ deviceCount, onlineCount, geofenceCount, equipmentCount }: DashboardStatsProps) {
  return (
    <div className="dash-bottom-left-stack">
      <div className="dash-stats dash-glass">
        <StatCard label="Dispositivos" value={deviceCount} icon={<NavIcon name="devices" size={18} />} />
        <StatCard label="En línea" value={onlineCount} icon={<NavIcon name="signal" size={18} />} />
        <StatCard label="Geocercas" value={geofenceCount} icon={<NavIcon name="geofence" size={18} />} />
        <StatCard label="Equipo estático" value={equipmentCount} icon={<NavIcon name="equipment" size={18} />} />
      </div>
    </div>
  );
}
