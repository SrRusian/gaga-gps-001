import { StatCard } from '@gaga-gps/ui';

export interface SupervisorStatsBarProps {
  total: number;
  online: number;
  alertCount: number;
  offline: number;
}

export function SupervisorStatsBar({ total, online, alertCount, offline }: SupervisorStatsBarProps) {
  return (
    <div className="sup-stats sup-glass">
      <StatCard label="Total" value={total} />
      <StatCard label="En línea" value={online} />
      <StatCard label="Alertas" value={alertCount} variant="alert" />
      <StatCard label="Sin señal" value={offline} variant="warning" />
    </div>
  );
}
