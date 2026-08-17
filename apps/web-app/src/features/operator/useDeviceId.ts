import { createApiClient } from '@gaga-gps/client';
import { useCallback, useState } from 'react';

const api = createApiClient();

interface DeviceLookupResponse {
  exists: boolean;
  name?: string;
  activeSession?: { userName: string; startedAt: string } | null;
}

/**
 * Identidad del vehículo - fija por configuración de kiosco, NO por
 * login. Se lee de ?device= en la URL (configurado una sola vez por
 * el técnico que instala la tableta) o, si falta, del valor guardado
 * en un arranque anterior.
 */
function resolveDeviceId(): string | null {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('device');
  if (fromUrl) {
    localStorage.setItem('gaga_operator_device_id', fromUrl);
    return fromUrl;
  }
  return localStorage.getItem('gaga_operator_device_id');
}

export function useDeviceId() {
  const [deviceId] = useState<string | null>(resolveDeviceId);
  const [error, setError] = useState('');
  const [verifying, setVerifying] = useState(false);

  const saveDeviceSetup = useCallback(async (value: string) => {
    const trimmed = value.trim();
    setError('');

    if (!trimmed) {
      setError('Ingresa el identificador del dispositivo');
      return;
    }

    setVerifying(true);
    try {
      const data = await api.get<DeviceLookupResponse>(
        `/api/devices/lookup/${encodeURIComponent(trimmed)}`,
      );

      if (!data.exists) {
        setError(
          `"${trimmed}" no existe en el sistema - verifica que coincida exactamente con el Device Identifier configurado en Traccar Client, y que la tableta ya haya enviado al menos una posición GPS.`,
        );
        return;
      }

      if (data.activeSession) {
        const proceed = confirm(
          `"${trimmed}" (${data.name}) ya tiene un turno activo con ${data.activeSession.userName} desde ${new Date(data.activeSession.startedAt).toLocaleString()}.\n\n` +
            `Si esta es una tableta DISTINTA a la que normalmente usa ese vehículo, probablemente hay un identificador duplicado - verifica con el administrador antes de continuar.\n\n` +
            `¿Continuar de todos modos?`,
        );
        if (!proceed) return;
      }
    } catch {
      setError('No se pudo verificar el dispositivo - revisa la conexión con el servidor');
      return;
    } finally {
      setVerifying(false);
    }

    localStorage.setItem('gaga_operator_device_id', trimmed);
    // Refleja el valor en la URL para que, si esta pantalla se guarda
    // como acceso directo/kiosco, quede ya configurado.
    const url = new URL(window.location.href);
    url.searchParams.set('device', trimmed);
    window.location.href = url.toString();
  }, []);

  return { deviceId, saveDeviceSetup, error, verifying };
}
