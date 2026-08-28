import type { MapMode } from '@gaga-gps/map-core';

export interface MapModeSelectorProps {
  mode: MapMode;
  onChange: (mode: MapMode) => void;
  satelliteAvailable?: boolean;
}

const OPTIONS: { mode: MapMode; label: string }[] = [
  { mode: 'streets', label: 'Calles' },
  { mode: 'satellite', label: 'Satelital' },
  { mode: 'hybrid', label: 'Mixto' },
];

export function MapModeSelector({ mode, onChange, satelliteAvailable = true }: MapModeSelectorProps) {
  return (
    <div className="gg-map-mode-selector">
      {OPTIONS.map((opt) => (
        <button
          key={opt.mode}
          className={`gg-map-mode-btn${mode === opt.mode ? ' active' : ''}`}
          disabled={opt.mode !== 'streets' && !satelliteAvailable}
          onClick={() => onChange(opt.mode)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
