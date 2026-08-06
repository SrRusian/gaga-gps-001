/**
 * mapMode.ts
 *
 * Selector de modo de mapa — Calles / Satelital / Mixto — con
 * persistencia en localStorage, igual que los 3 paneles hoy.
 */
import { useCallback, useState } from 'react';

export type MapMode = 'streets' | 'satellite' | 'hybrid';

export function useMapMode(
  storageKey: string,
  defaultMode: MapMode = 'hybrid',
): [MapMode, (mode: MapMode) => void] {
  const [mode, setModeState] = useState<MapMode>(() => {
    if (typeof window === 'undefined') return defaultMode;
    return (localStorage.getItem(storageKey) as MapMode | null) || defaultMode;
  });

  const setMode = useCallback(
    (next: MapMode) => {
      setModeState(next);
      localStorage.setItem(storageKey, next);
    },
    [storageKey],
  );

  return [mode, setMode];
}
