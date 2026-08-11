import { PositionFilterService } from '@gaga-gps/map-core';
import { useEffect, useRef, useState } from 'react';

export interface DeviceGeolocation {
  latitude: number;
  longitude: number;
  speed: number | null;
  heading: number | null;
  accuracy: number | null;
  altitude: number | null;
  timestamp: number;
}

const WATCH_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 2000,
  timeout: 10000,
};

const ERROR_CODE_LABEL: Record<number, string> = {
  1: 'Permiso denegado',
  2: 'Posición no disponible',
  3: 'Tiempo de espera agotado',
};

// Misma clave interna para las dos instancias del filtro (backend y
// este hook) — cada uno corre en su propio proceso/dispositivo, no
// comparten estado, solo la lógica.
const LOCAL_FILTER_DEVICE_KEY = 'local-device';

// Sensor local del dispositivo — funciona sin conexión al servidor.
// Pasa por la misma lógica anti-teletransporte que usa el backend
// para Traccar Client (PositionFilterService, copia en
// @gaga-gps/map-core — ver comentario ahí) — sin esto, un salto de
// fix/float del RTK que el servidor ya descarta para lo que ve el
// supervisor seguiría mostrándose, sin
// filtrar, en la pantalla del propio operador.
export function useDeviceGeolocation() {
  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator;
  const [position, setPosition] = useState<DeviceGeolocation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filterRef = useRef<PositionFilterService | null>(null);
  if (!filterRef.current) filterRef.current = new PositionFilterService();

  useEffect(() => {
    if (!supported) return;

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setError(null);

        const verdict = filterRef.current!.evaluate({
          deviceId: LOCAL_FILTER_DEVICE_KEY,
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          fixTime: pos.timestamp,
        });

        // Salto físicamente implausible (glitch fix/float del RTK) —
        // se ignora y se mantiene la última posición aceptada en
        // pantalla, igual que hace el backend con lo que ve el resto
        // de la flota.
        if (!verdict.accepted) return;

        setPosition({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          speed: pos.coords.speed,
          heading: pos.coords.heading,
          accuracy: pos.coords.accuracy,
          altitude: pos.coords.altitude,
          timestamp: pos.timestamp,
        });
      },
      (err) => {
        const label = ERROR_CODE_LABEL[err.code] ?? `Código ${err.code}`;
        setError(`${label}${err.message ? ` — ${err.message}` : ''}`);
      },
      WATCH_OPTIONS,
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [supported]);

  return { position, error, supported };
}
