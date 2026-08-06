export interface StatCardProps {
  label: string;
  value: string | number;
  variant?: 'normal' | 'alert' | 'warning';
}

export function StatCard({ label, value, variant = 'normal' }: StatCardProps) {
  const valueClass =
    variant === 'normal'
      ? 'gg-stat-card__value'
      : `gg-stat-card__value gg-stat-card__value--${variant}`;
  return (
    <div className="gg-stat-card">
      <div className="gg-stat-card__label">{label}</div>
      <div className={valueClass}>{value}</div>
    </div>
  );
}
