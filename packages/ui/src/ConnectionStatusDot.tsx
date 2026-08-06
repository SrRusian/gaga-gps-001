export interface ConnectionStatusDotProps {
  connected: boolean;
}

export function ConnectionStatusDot({ connected }: ConnectionStatusDotProps) {
  return <span className={`gg-connection-dot${connected ? ' connected' : ''}`} />;
}
