import type { ReactNode } from 'react';

export interface StatCardProps {
  label: string;
  value: string | number;
  variant?: 'normal' | 'alert' | 'warning';
  icon?: ReactNode;
}

export function StatCard({ label, value, variant = 'normal', icon }: StatCardProps) {
  // solo variant "normal" se pinta de azul al activarse - alert/warning ya tienen su propio
  // color semantico fijo (rojo/naranja), sin importar la cantidad
  const numericValue = typeof value === 'number' ? value : Number(value);
  const active = variant === 'normal' && Number.isFinite(numericValue) && numericValue > 0;

  const valueClass = [
    'gg-stat-card__value',
    variant !== 'normal' && `gg-stat-card__value--${variant}`,
    active && 'gg-stat-card__value--active',
  ]
    .filter(Boolean)
    .join(' ');
  const iconClass = ['gg-stat-card__icon', active && 'gg-stat-card__icon--active'].filter(Boolean).join(' ');

  return (
    <div className="gg-stat-card">
      {icon && <div className={iconClass}>{icon}</div>}
      <div className="gg-stat-card__label">{label}</div>
      <div className={valueClass}>{value}</div>
    </div>
  );
}
