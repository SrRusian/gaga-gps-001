import type { ReactNode } from 'react';

// Iconos de navegacion del panel Admin - un solo SVG por nombre, stroke currentColor
export type IconName =
  | 'dashboard'
  | 'system'
  | 'projectNew'
  | 'projects'
  | 'shifts'
  | 'devices'
  | 'signal'
  | 'users'
  | 'geofence'
  | 'equipment'
  | 'maps'
  | 'history'
  | 'logout'
  | 'chevron'
  | 'collapse'
  | 'expand'
  | 'pin';

const PATHS: Record<IconName, ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  system: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1" />
    </>
  ),
  projectNew: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h3.6l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </>
  ),
  projects: (
    <>
      <rect x="3" y="8" width="18" height="12" rx="2" />
      <path d="M6.5 8V6a1.5 1.5 0 0 1 1.5-1.5h2.4l1.6 1.6H18" />
    </>
  ),
  shifts: (
    <>
      <rect x="3.5" y="5" width="17" height="16" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
      <circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  devices: (
    <>
      <rect x="6" y="3" width="12" height="18" rx="2" />
      <path d="M10.5 18h3" />
    </>
  ),
  signal: (
    <>
      <path d="M4.5 12.5a10.5 10.5 0 0 1 15 0" />
      <path d="M7.7 15.7a6 6 0 0 1 8.6 0" />
      <circle cx="12" cy="18.5" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.6 19.5a5.5 5.5 0 0 1 10.8 0" />
      <path d="M16 5.3a3 3 0 0 1 0 5.4" />
      <path d="M17.2 14.3a5.5 5.5 0 0 1 3.2 4.7" />
    </>
  ),
  geofence: (
    <>
      <path d="M12 3l8.2 6-3.1 9.6H6.9L3.8 9z" />
      <circle cx="12" cy="11" r="1.7" fill="currentColor" stroke="none" />
    </>
  ),
  equipment: (
    <>
      <path d="M5 15v-1a7 7 0 0 1 14 0v1" />
      <path d="M9.5 8.3V7a2.5 2.5 0 0 1 5 0v1.3" />
      <rect x="2.5" y="15" width="19" height="3.3" rx="1.3" />
    </>
  ),
  maps: (
    <>
      <path d="M9 4 3.7 5.8A1 1 0 0 0 3 6.7v12.4a1 1 0 0 0 1.3.95L9 18.6l6 2 4.7-1.6a1 1 0 0 0 .7-.95V5.6a1 1 0 0 0-1.3-.95L15 6z" />
      <path d="M9 4v14.6M15 6v14" />
    </>
  ),
  history: (
    <>
      <path d="M3.5 8A9 9 0 1 1 3 12" />
      <path d="M3.5 3.5V8H8" />
      <path d="M12 8v4.3l3 1.8" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
      <path d="M15.5 16.5 20 12l-4.5-4.5" />
      <path d="M20 12H9" />
    </>
  ),
  chevron: <path d="M6 9.5l6 6 6-6" />,
  collapse: <path d="M12.5 17l-5-5 5-5M19 17l-5-5 5-5" />,
  expand: <path d="M11.5 17l5-5-5-5M5 17l5-5-5-5" />,
  pin: (
    <>
      <path d="M12 22s7-6.7 7-12A7 7 0 0 0 5 10c0 5.3 7 12 7 12Z" />
      <circle cx="12" cy="10" r="2.6" />
    </>
  ),
};

export interface NavIconProps {
  name: IconName;
  size?: number;
  className?: string;
}

export function NavIcon({ name, size = 20, className }: NavIconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
