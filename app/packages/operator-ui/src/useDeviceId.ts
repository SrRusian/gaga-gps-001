import { getDeviceId } from '@gaga-gps/client';
import { useState } from 'react';

// el identificador del vehiculo ya vive en Ajustes ("Servidor e identidad", el mismo que usa
// Traccar para mandar posicion) - antes de la app unificada de 3-en-1, Operador no tenia forma de
// saber que tableta/vehiculo era y pedia escribirlo a mano aparte; ahora es un solo dato, una sola
// fuente de verdad. Si esta vacio, Ajustes es donde se configura, no aqui.
export function useDeviceId(): string | null {
  const [deviceId] = useState<string | null>(() => getDeviceId() || null);
  return deviceId;
}
