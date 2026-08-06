export type AlertSeverity = 'danger' | 'warning' | 'info';

export interface AlertBannerProps {
  severity: AlertSeverity;
  message: string;
  time?: string;
}

export function AlertBanner({ severity, message, time }: AlertBannerProps) {
  return (
    <div className={`gg-alert-banner gg-alert-banner--${severity}`}>
      <div>{message}</div>
      {time && <div className="gg-alert-banner__time">{time}</div>}
    </div>
  );
}
