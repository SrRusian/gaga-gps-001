import type { ReactNode } from 'react';

export interface StatCardProps {
  label: string;
  value: string | number;
  variant?: 'normal' | 'alert' | 'warning';
  icon?: ReactNode;
}

export function StatCard({ label, value, variant = 'normal', icon }: StatCardProps) {
  const valueClass =
    variant === 'normal'
      ? 'gg-stat-card__value'
      : `gg-stat-card__value gg-stat-card__value--${variant}`;
  return (
    <div className="gg-stat-card">
      {icon && <div className="gg-stat-card__icon">{icon}</div>}
      <div className="gg-stat-card__label">{label}</div>
      <div className={valueClass}>{value}</div>
    </div>
  );
}
