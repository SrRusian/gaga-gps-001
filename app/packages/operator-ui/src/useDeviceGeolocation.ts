import { PositionFilterService } from '@gaga-gps/map-core';
import { RtkNtrip } from '@gaga-gps/android-bridge';
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

  // ultimo timestamp aceptado, de cualquiera de las 2 fuentes - evita que un fix mas lento en
  // llegar (ej. navigator.geolocation, que el navegador entrega ~1/seg) pise uno mas fresco que ya
  // se mostro (ej. rtkFix nativo, hasta 5-10/seg con el receptor RTK conectado - ver mas abajo)
  const lastAcceptedAtRef = useRef<number>(0);

  useEffect(() => {
    function tryAccept(candidate: DeviceGeolocation) {
      if (candidate.timestamp < lastAcceptedAtRef.current) return;

      const verdict = filterRef.current!.evaluate({
        deviceId: LOCAL_FILTER_DEVICE_KEY,
        latitude: candidate.latitude,
        longitude: candidate.longitude,
        fixTime: candidate.timestamp,
      });
      if (!verdict.accepted) return;

      lastAcceptedAtRef.current = candidate.timestamp;
      setPosition(candidate);
    }

    // fuente base: siempre activa, funciona tanto en navegador normal como dentro de la app -
    // requiere HTTPS/localhost exacto, si no PERMISSION_DENIED sin diálogo. El navegador decide
    // solo cada cuánto entrega un fix nuevo (en la práctica, ~1/seg en Android sin importar qué
    // tan rápido produzca datos el GPS/receptor RTK real) - eso es justo lo que rtkFix evita abajo.
    let watchId: number | null = null;
    if (supported) {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          setError(null);
          tryAccept({
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
    }

    // fuente rápida opcional: solo emite mientras el receptor RTK está conectado y entregando
    // fixes reales (ver RtkNtripPlugin.emitFix, Kotlin) - al ritmo real del receptor (5-10Hz
    // típico), sin pasar por el límite de ~1/seg de arriba. Fuera de la app nativa o sin RTK
    // conectado, sencillamente nunca dispara y el hook sigue funcionando solo con la fuente base.
    let removeRtkListener: (() => void) | null = null;
    RtkNtrip.addListener('rtkFix', (fix) => {
      tryAccept({
        latitude: fix.latitude,
        longitude: fix.longitude,
        speed: fix.speedMps ?? null,
        heading: fix.courseDeg ?? null,
        accuracy: fix.accuracyMeters,
        altitude: null,
        timestamp: fix.timestamp,
      });
    }).then((handle) => {
      removeRtkListener = () => handle.remove();
    });

    return () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      removeRtkListener?.();
    };
  }, [supported]);

  return { position, error, supported };
}
