import { createApiClient, getStoredToken } from '@gaga-gps/client';
import { useEffect, useState } from 'react';

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
}

// silueta real del vehiculo (largo/ancho, metros) por deviceId - GET /api/devices ya trae el join
// contra vehicle_types (ver DeviceRepository.SELECT_WITH_VEHICLE_TYPE en el backend). Fetch unico
// al montar - las asignaciones de tipo cambian con poca frecuencia (las hace un administrador),
// no necesita refrescarse en vivo por socket.
export function useVehicleFootprints() {
  const [footprints, setFootprints] = useState<Record<string, VehicleFootprint>>({});

  useEffect(() => {
    api
      .get<DeviceRow[]>('/api/devices')
      .then((rows) => {
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
  }, []);

  return footprints;
}
