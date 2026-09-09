import { StatCard } from '@gaga-gps/ui';

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
        <StatCard label="Dispositivos" value={deviceCount} />
        <StatCard label="En línea" value={onlineCount} />
        <StatCard label="Geocercas" value={geofenceCount} />
        <StatCard label="Equipo estático" value={equipmentCount} />
      </div>
    </div>
  );
}
