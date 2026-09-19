import { createApiClient, getStoredToken } from '@gaga-gps/client';
import { useEffect, useState } from 'react';
import { NO_SPEED_LIMITS, type SpeedLimits } from './localSpeed';

const api = createApiClient({ getToken: getStoredToken });

export interface VehicleFootprint {
  vehicleTypeName: string | null;
  lengthMeters: number | null;
  widthMeters: number | null;
}

interface DeviceRow {
  unique_id: string;
  vehicle_type_name?: string | null;
  vehicle_type_length_meters?: number | null;
  vehicle_type_width_meters?: number | null;
  speed_limit_kmh?: number | null;
  group_speed_limit_kmh?: number | null;
  vehicle_type_max_speed_kmh?: number | null;
}

const LIMITS_CACHE_KEY = 'gaga_speed_limits';

// silueta real del vehiculo (largo/ancho, metros) por deviceId - GET /api/devices ya trae el join
// contra vehicle_types (ver DeviceRepository.SELECT_WITH_VEHICLE_TYPE en el backend). Fetch unico
// al montar - las asignaciones de tipo cambian con poca frecuencia (las hace un administrador),
// no necesita refrescarse en vivo por socket.
export function useVehicleFootprints(myDeviceId?: string | null) {
  const [footprints, setFootprints] = useState<Record<string, VehicleFootprint>>({});
  // los limites del propio vehiculo se cachean: desde que la tableta evalua el exceso por su
  // cuenta, tiene que poder hacerlo aunque arranque sin red (ver localSpeed.ts)
  const [limits, setLimits] = useState<SpeedLimits>(() => loadCachedLimits());

  useEffect(() => {
    api
      .get<DeviceRow[]>('/api/devices')
      .then((rows) => {
        const mine = myDeviceId ? rows.find((d) => d.unique_id === myDeviceId) : undefined;
        if (mine) {
          const next: SpeedLimits = {
            deviceLimitKmh: mine.speed_limit_kmh ?? null,
            groupLimitKmh: mine.group_speed_limit_kmh ?? null,
            vehicleTypeLimitKmh: mine.vehicle_type_max_speed_kmh ?? null,
          };
          setLimits(next);
          try {
            localStorage.setItem(LIMITS_CACHE_KEY, JSON.stringify(next));
          } catch {
            // almacenamiento bloqueado - se sigue usando lo que ya esta en memoria
          }
        }
        setFootprints(
          Object.fromEntries(
            rows.map((d) => [
              d.unique_id,
              {
                vehicleTypeName: d.vehicle_type_name ?? null,
                lengthMeters: d.vehicle_type_length_meters ?? null,
                widthMeters: d.vehicle_type_width_meters ?? null,
              },
            ]),
          ),
        );
      })
      .catch(() => {});
  }, [myDeviceId]);

  return { footprints, limits };
}

function loadCachedLimits(): SpeedLimits {
  try {
    const raw = localStorage.getItem(LIMITS_CACHE_KEY);
    if (!raw) return NO_SPEED_LIMITS;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as SpeedLimits) : NO_SPEED_LIMITS;
  } catch {
    return NO_SPEED_LIMITS;
  }
}
