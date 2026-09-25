import { useEffect, useState } from 'react';

// Conectividad real del dispositivo (datos/wifi), independiente de si el servidor responde -
// eventos nativos del navegador/WebView, sin polling ni costo de bateria mientras no cambia.
// Distingue "Sin Red" (sin datos/wifi en absoluto) de "Desconectado" (hay red pero el servidor
// no responde) - dos problemas distintos, con mensajes distintos para el operador.
export function useNetworkOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}

export type NetworkType = 'wifi' | 'cellular' | 'ethernet' | 'none' | 'unknown';

interface NavigatorConnection extends EventTarget {
  type?: string;
}

function readNetworkType(): NetworkType {
  if (typeof navigator === 'undefined') return 'unknown';
  // Network Information API - solo Chromium (el WebView de Android lo trae), sin fallback cross-
  // browser a proposito, esta app nunca corre fuera de un WebView Android real en produccion
  const conn = (navigator as Navigator & { connection?: NavigatorConnection }).connection;
  switch (conn?.type) {
    case 'wifi':
      return 'wifi';
    case 'cellular':
      return 'cellular';
    case 'ethernet':
      return 'ethernet';
    case 'none':
      return 'none';
    default:
      return 'unknown';
  }
}

// WiFi vs datos moviles - Network Information API, evento 'change' del propio navegador, sin
// polling. No intenta verificar "internet real" con una peticion de red aparte (eso costaria datos
// y bateria en un ciclo continuo) - el dato de si el servidor responde ya lo cubre el chip de
// conexion (useOperatorSocket + useNetworkOnline), este hook solo describe QUE interfaz esta activa
export function useNetworkType(): NetworkType {
  const [type, setType] = useState<NetworkType>(() => readNetworkType());

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const conn = (navigator as Navigator & { connection?: NavigatorConnection }).connection;
    if (!conn) return;
    const handler = () => setType(readNetworkType());
    conn.addEventListener('change', handler);
    return () => conn.removeEventListener('change', handler);
  }, []);

  return type;
}
