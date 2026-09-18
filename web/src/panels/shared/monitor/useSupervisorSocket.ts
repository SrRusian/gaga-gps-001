import { createSocket } from '@gaga-gps/client';
import type { GagaSocket } from '@gaga-gps/client';
import type { ActiveMap, Geofence, Position, StaticEquipment } from '@gaga-gps/shared-types';
import type { EquipmentMarkerData } from '@gaga-gps/map-core';
import { useEffect, useState } from 'react';
import { useAlertsFeed } from '../hooks/useAlertsFeed';

export { INCIDENT_CATEGORY_LABEL } from '../hooks/useAlertsFeed';
export type { AlertEntry } from '../hooks/useAlertsFeed';

export interface FleetVehicle extends Position {
  lastSeen: number;
}

function toMarkerData(eq: StaticEquipment): EquipmentMarkerData {
  return {
    id: eq.id,
    name: eq.name,
    latitude: eq.lat,
    longitude: eq.lon,
    swingRadiusMeters: eq.swingRadius,
    safetyRadiusMeters: eq.safetyRadius,
    linkedDeviceId: eq.linkedDeviceId,
  };
}

export function useSupervisorSocket() {
  const [connected, setConnected] = useState(false);
  const [socket, setSocket] = useState<GagaSocket | null>(null);
  const [fleet, setFleet] = useState<Record<string, FleetVehicle>>({});
  const [geofences, setGeofences] = useState<Geofence[]>([]);
  const [equipment, setEquipment] = useState<EquipmentMarkerData[]>([]);
  const [activeMaps, setActiveMaps] = useState<ActiveMap[]>([]);

  useEffect(() => {
    const s = createSocket();
    setSocket(s);

    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));

    s.on('maps:active_update', ({ maps }) => setActiveMaps(maps));
    s.on('geofences:update', (gs) => setGeofences(gs));
    s.on('equipment:update', (eqs: StaticEquipment[]) => setEquipment(eqs.map(toMarkerData)));

    s.on('fleet:update', (data) => {
      setFleet((prev) => {
        const next = { ...prev };
        data.positions.forEach((pos) => {
          const lastSeen = pos.fixTime ? new Date(pos.fixTime).getTime() : Date.now();
          next[pos.deviceId] = { ...pos, lastSeen };
        });
        return next;
      });
    });

    return () => {
      s.disconnect();
      setSocket(null);
    };
  }, []);

  const alertsFeed = useAlertsFeed(socket);

  return {
    connected,
    fleet,
    geofences,
    equipment,
    activeMaps,
    ...alertsFeed,
  };
}
