export interface VehicleCardProps {
  name: string;
  type?: string;
  status: 'online' | 'offline' | 'alert';
  info?: string;
  hasAlert?: boolean;
  onClick?: () => void;
}

export function VehicleCard({ name, type, status, info, hasAlert, onClick }: VehicleCardProps) {
  return (
    <div
      className={`gg-vehicle-card${hasAlert ? ' gg-vehicle-card--alert' : ''}`}
      onClick={onClick}
    >
      <div className="gg-vehicle-card__header">
        <span className="gg-vehicle-card__name">
          {name}
          {type && <span style={{ fontWeight: 'normal', color: '#8b949e' }}> · {type}</span>}
        </span>
        <span
          className={`gg-vehicle-card__status gg-vehicle-card__status--${status === 'online' ? '' : status}`}
        >
          {status === 'online' ? 'En línea' : status === 'offline' ? 'Sin señal' : 'Alerta'}
        </span>
      </div>
      {info && <div className="gg-vehicle-card__info">{info}</div>}
    </div>
  );
}
