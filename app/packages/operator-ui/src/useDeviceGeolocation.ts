import { PositionFilterService } from '@gaga-gps/map-core';
import { Power, RtkNtrip } from '@gaga-gps/android-bridge';
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

// mientras haya llegado un fix nativo (rtkFix o gpsFix) hace menos de esto, navigator.geolocation
// se ignora por completo - ver comentario junto a lastNativeFixAtRef
const NATIVE_PRIORITY_WINDOW_MS = 3000;

export function useDeviceGeolocation() {
  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator;
  const [position, setPosition] = useState<DeviceGeolocation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filterRef = useRef<PositionFilterService | null>(null);
  if (!filterRef.current) filterRef.current = new PositionFilterService();

  // ultimo timestamp aceptado, de cualquiera de las fuentes - evita que un fix mas lento en
  // llegar (ej. navigator.geolocation, que el navegador entrega ~1/seg) pise uno mas fresco que ya
  // se mostro (ej. rtkFix nativo, hasta 5-10/seg con el receptor RTK conectado - ver mas abajo)
  const lastAcceptedAtRef = useRef<number>(0);

  // reloj real (Date.now(), no el timestamp del propio fix) de la ultima vez que llego un fix
  // nativo - bug real reportado en campo: con RTK conectado pero sin fix todavia (buscando
  // satelites), GPS_PROVIDER nunca se secuestra (ver MockLocationFeeder), asi que gpsFix entrega
  // el GPS crudo real de la tableta MIENTRAS navigator.geolocation sigue entregando su propia
  // lectura (normalmente Fused Location de Play Services, GPS+red combinados) - dos fuentes con
  // sesgo ligeramente distinto entre si, compitiendo por timestamp mas reciente cada segundo, se
  // veia como el marcador "teletransportandose" unos metros y regresando con el vehiculo detenido,
  // y el circulo de precision creciendo/achicandose al alternar entre la exactitud reportada por
  // cada una. Fix: mientras haya un fix nativo reciente, navigator.geolocation se ignora del todo
  // - solo compite consigo mismo cuando el nativo lleva mas de NATIVE_PRIORITY_WINDOW_MS callado
  // (servicio de envio continuo apagado, o fuera de la app nativa).
  const lastNativeFixAtRef = useRef<number>(0);

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

    function startWatching() {
      if (watchId !== null || !supported) return;
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          setError(null);
          if (Date.now() - lastNativeFixAtRef.current < NATIVE_PRIORITY_WINDOW_MS) return;
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

    // navigator.geolocation.watchPosition sigue pidiendo el chip GPS real aunque RTK ya se haya
    // desconectado - es independiente del GPS nativo, que power/PowerSuspendAlarmReceiver.kt ya
    // apaga por su cuenta. Sin esto, la suspension por perdida de corriente no era total: el
    // navegador seguia pidiendo posicion aunque la pantalla estuviera apagada.
    function stopWatching() {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
    }

    startWatching();

    // fuente rápida opcional: solo emite mientras el receptor RTK está conectado y entregando
    // fixes reales (ver RtkNtripPlugin.emitFix, Kotlin) - al ritmo real del receptor (5-10Hz
    // típico), sin pasar por el límite de ~1/seg de arriba. Fuera de la app nativa o sin RTK
    // conectado, sencillamente nunca dispara y el hook sigue funcionando solo con la fuente base.
    let removeRtkListener: (() => void) | null = null;
    RtkNtrip.addListener('rtkFix', (fix) => {
      lastNativeFixAtRef.current = Date.now();
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

    // mismo fix exacto que TraccarSenderService ya mando al servidor (ver RtkNtripPlugin.
    // emitGpsFix, Kotlin) - bug real reportado en campo: el marcador propio del Operador (via
    // navigator.geolocation, que en Android normalmente resuelve por Fused Location de Play
    // Services - GPS+red combinados) se veia en un punto distinto al que Admin/Supervisor ven
    // desde el servidor (que recibe el GPS_PROVIDER crudo). Se trata como una fuente mas, por
    // timestamp (mismo tryAccept de arriba) - si rtkFix ya entrego algo mas reciente, esto se
    // descarta solo sin pisar nada. Fuera de la app nativa, o si el envio continuo esta apagado,
    // simplemente nunca dispara y el hook sigue funcionando solo con navigator.geolocation.
    let removeGpsListener: (() => void) | null = null;
    RtkNtrip.addListener('gpsFix', (fix) => {
      lastNativeFixAtRef.current = Date.now();
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
      removeGpsListener = () => handle.remove();
    });

    Power.getStatus().then((status) => {
      if (status.suspended) stopWatching();
    });
    const powerListenerPromise = Power.addListener('powerStatus', (status) => {
      if (status.suspended) stopWatching();
      else startWatching();
    });

    return () => {
      stopWatching();
      removeRtkListener?.();
      removeGpsListener?.();
      powerListenerPromise.then((h) => h.remove());
    };
  }, [supported]);

  return { position, error, supported };
}
