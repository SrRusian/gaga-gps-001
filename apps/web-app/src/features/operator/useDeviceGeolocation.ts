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

const LOCAL_FILTER_DEVICE_KEY = 'local-device';

export function useDeviceGeolocation() {
  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator;
  const [position, setPosition] = useState<DeviceGeolocation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filterRef = useRef<PositionFilterService | null>(null);
  if (!filterRef.current) filterRef.current = new PositionFilterService();

  useEffect(() => {
    if (!supported) return;

    // requiere HTTPS/localhost exacto - si no, PERMISSION_DENIED sin diálogo
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setError(null);

        const verdict = filterRef.current!.evaluate({
          deviceId: LOCAL_FILTER_DEVICE_KEY,
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          fixTime: pos.timestamp,
        });

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
        setError(`${label}${err.message ? ` - ${err.message}` : ''}`);
      },
      WATCH_OPTIONS,
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [supported]);

  return { position, error, supported };
}
