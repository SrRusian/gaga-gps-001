export type AlertSeverity = 'danger' | 'warning' | 'info';

export interface AlertBannerProps {
  severity: AlertSeverity;
  message: string;
  time?: string;
  /** Solo las alertas que no se resuelven solas (incidentes reportados por un operador) lo usan. */
  onResolve?: () => void;
  resolveLabel?: string;
}

export function AlertBanner({
  severity,
  message,
  time,
  onResolve,
  resolveLabel = 'Resolver',
}: AlertBannerProps) {
  return (
    <div className={`gg-alert-banner gg-alert-banner--${severity}`}>
      <div className="gg-alert-banner__row">
        <div>{message}</div>
        {onResolve && (
          <button className="gg-alert-banner__resolve" onClick={onResolve}>
            {resolveLabel}
          </button>
        )}
      </div>
      {time && <div className="gg-alert-banner__time">{time}</div>}
    </div>
  );
}
