import { StatCard } from '@gaga-gps/ui';
import { NavIcon } from '../../components/NavIcons';

export interface SupervisorStatsBarProps {
  total: number;
  online: number;
  alertCount: number;
  offline: number;
}

export function SupervisorStatsBar({ total, online, alertCount, offline }: SupervisorStatsBarProps) {
  return (
    <div className="sup-stats sup-glass">
      <StatCard label="Total" value={total} icon={<NavIcon name="devices" size={18} />} />
      <StatCard label="En línea" value={online} icon={<NavIcon name="signal" size={18} />} />
      <StatCard label="Alertas" value={alertCount} variant="alert" icon={<NavIcon name="alertTriangle" size={18} />} />
      <StatCard label="Sin señal" value={offline} variant="warning" icon={<NavIcon name="signalOff" size={18} />} />
    </div>
  );
}
