import { createSocket } from '@gaga-gps/client';
import type {
  ActiveMap,
  Geofence,
  IncidentReportedPayload,
  Position,
  StaticEquipment,
} from '@gaga-gps/shared-types';
import type { EquipmentMarkerData } from '@gaga-gps/map-core';
import { useEffect, useRef, useState } from 'react';
import { useAlertSound } from './useAlertSound';

/** Forma en memoria (StaticEquipmentManager) -> forma que espera useEquipmentLayer. */
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

export interface AlertState {
  severity: 'warning' | 'danger' | 'info' | null;
  message: string;
}

export interface NearestVehicle {
  deviceId: string;
  distance: number;
}

export interface ThreatVehicle {
  deviceId: string;
  distance: number;
}

// Mismos umbrales que SignalLostService.ts (backend) - mantenidos en
// sincronía a propósito, ver comentario ahí. Estos corren en el
// cliente porque, si el propio socket está caído, el servidor no
// tiene forma de empujarle `signal:lost:level1/2` a este operador.
const LOCAL_DISCONNECT_LEVEL1_MS = 10000;
const LOCAL_DISCONNECT_LEVEL2_MS = 20000;

export function useOperatorSocket(deviceId: string | null) {
  const [connected, setConnected] = useState(false);
  const [fleet, setFleet] = useState<Record<string, Position>>({});
  const [geofences, setGeofences] = useState<Geofence[]>([]);
  const [equipment, setEquipment] = useState<EquipmentMarkerData[]>([]);
  const [activeMaps, setActiveMaps] = useState<ActiveMap[]>([]);
  const [myPosition, setMyPosition] = useState<Position | null>(null);
  const [myOnline, setMyOnline] = useState(false);
  const [alert, setAlert] = useState<AlertState>({ severity: null, message: '' });
  const [nearestVehicle, setNearestVehicle] = useState<NearestVehicle | null>(null);
  const [threat, setThreat] = useState<ThreatVehicle | null>(null);
  const [activeGeofenceId, setActiveGeofenceId] = useState<number | null>(null);
  const [incidents, setIncidents] = useState<Record<number, IncidentReportedPayload>>({});
  const { playWarningSound, playDangerSound, stopSound } = useAlertSound();

  // Refs para no re-suscribir el socket cada vez que cambian (los
  // handlers de socket.io capturan closures al momento de registrarse).
  const soundsRef = useRef({ playWarningSound, playDangerSound, stopSound });
  soundsRef.current = { playWarningSound, playDangerSound, stopSound };

  // Detección local de desconexión - independiente del servidor.
  const disconnectedAtRef = useRef<number | null>(null);
  const localSignalLevelRef = useRef<'none' | 'level1' | 'level2'>('none');

  useEffect(() => {
    // Sin vehículo registrado no hay "mi posición" ni turno posible -
    // ni siquiera vale la pena abrir el socket. El operador ve un
    // mapa vacío hasta que registre un vehículo (ver OperatorApp).
    if (!deviceId) return;

    const socket = createSocket();

    const showWarning = (message: string) => setAlert({ severity: 'warning', message });
    const showDanger = (message: string) => setAlert({ severity: 'danger', message });
    const showInfo = (message: string) => setAlert({ severity: 'info', message });
    const clearAlertState = () => setAlert({ severity: null, message: '' });

    socket.on('connect', () => {
      setConnected(true);
      disconnectedAtRef.current = null;
      if (localSignalLevelRef.current !== 'none') {
        localSignalLevelRef.current = 'none';
        clearAlertState();
        soundsRef.current.stopSound();
      }
    });
    socket.on('disconnect', () => {
      setConnected(false);
      setMyOnline(false);
      disconnectedAtRef.current = Date.now();
    });

    socket.on('maps:active_update', ({ maps }) => setActiveMaps(maps));
    socket.on('geofences:update', (gs) => setGeofences(gs));
    socket.on('equipment:update', (eqs: StaticEquipment[]) => setEquipment(eqs.map(toMarkerData)));

    socket.on('fleet:update', (data) => {
      setFleet((prev) => {
        const next = { ...prev };
        data.positions.forEach((pos) => {
          next[pos.deviceId] = pos;
        });
        return next;
      });

      const mine = data.positions.find((p) => p.deviceId === deviceId);
      if (mine) {
        setMyPosition(mine);
        setMyOnline(true);
      }
    });

    // RF-ALR-02/03 - geocercas
    socket.on('alert:warning', (data) => {
      if (data.deviceId === deviceId) {
        showWarning(data.message);
        setActiveGeofenceId(data.geofenceId);
        soundsRef.current.playWarningSound();
      }
    });
    socket.on('alert:critical', (data) => {
      if (data.deviceId === deviceId) {
        showDanger(data.message);
        setActiveGeofenceId(data.geofenceId);
        soundsRef.current.playDangerSound(data.loop);
      }
    });
    // Zonas de estacionamiento - solo visual, sin sonido/sirena.
    socket.on('alert:info', (data) => {
      if (data.deviceId === deviceId) {
        showInfo(data.message);
        setActiveGeofenceId(data.geofenceId);
      }
    });
    socket.on('alert:clear', (data) => {
      if (data.deviceId === deviceId) {
        clearAlertState();
        setActiveGeofenceId(null);
        soundsRef.current.stopSound();
      }
    });

    // RF-ALR-05 - pérdida de señal (broadcast a toda la flota, no filtrado por deviceId)
    socket.on('signal:lost:level1', (data) => {
      showWarning(data.message);
      soundsRef.current.playWarningSound();
    });
    socket.on('signal:lost:level2', (data) => {
      showDanger(data.message);
      soundsRef.current.playDangerSound(data.loop);
    });
    socket.on('signal:recovered', () => {
      clearAlertState();
      soundsRef.current.stopSound();
    });

    // RF-ALR-10 - anticolisión
    socket.on('collision:proximity', (data) => {
      showWarning(data.message);
      soundsRef.current.playWarningSound();
    });
    socket.on('collision:critical', (data) => {
      showDanger(data.message);
      soundsRef.current.playDangerSound(data.loop);
      const otherId = String(data.deviceId1) === deviceId ? data.deviceId2 : data.deviceId1;
      setThreat({ deviceId: String(otherId), distance: data.distance });
    });
    socket.on('collision:clear', () => {
      clearAlertState();
      soundsRef.current.stopSound();
      setThreat(null);
    });

    // Proximidad fuera de ruta - VehicleProximityService
    socket.on('proximity:distance_update', (data) => {
      if (data.deviceId === deviceId) {
        setNearestVehicle({ deviceId: data.nearestDeviceId, distance: data.distance });
      }
    });
    socket.on('proximity:warning', (data) => {
      showWarning(data.message);
      soundsRef.current.playWarningSound();
    });
    socket.on('proximity:critical', (data) => {
      showDanger(data.message);
      soundsRef.current.playDangerSound(data.loop);
      const otherId = data.deviceId1 === deviceId ? data.deviceId2 : data.deviceId1;
      setThreat({ deviceId: otherId, distance: data.distance });
    });
    socket.on('proximity:clear', () => {
      clearAlertState();
      soundsRef.current.stopSound();
      setThreat(null);
      setNearestVehicle(null);
    });

    // RF-ALR-12 - aproximación a equipo estático
    socket.on('equipment:approach_outer', (data) => {
      if (data.deviceId === deviceId) showWarning(data.message);
    });
    socket.on('equipment:approach_inner', (data) => {
      if (data.deviceId === deviceId) {
        showWarning(`${data.message} - VELOCIDAD MÁXIMA 5 km/h`);
        soundsRef.current.playWarningSound();
      }
    });
    socket.on('equipment:minimum_limit', (data) => {
      if (data.deviceId === deviceId) {
        showDanger(data.message);
        soundsRef.current.playDangerSound(data.loop);
      }
    });
    socket.on('equipment:approach_clear', (data) => {
      if (data.deviceId === deviceId) {
        clearAlertState();
        soundsRef.current.stopSound();
      }
    });

    // Alertas de incidente en tiempo real (estilo Waze/Uber) -
    // IncidentAlertService. `incident:nearby` sí se filtra por
    // deviceId (es un aviso dirigido a quien se está acercando); los
    // marcadores en el mapa (`incident:reported`/`resolved`) son
    // para todos los vehículos del proyecto, sin filtrar.
    socket.on('incident:reported', (data) => {
      setIncidents((prev) => ({ ...prev, [data.id]: data }));
    });
    socket.on('incident:resolved', (data) => {
      setIncidents((prev) => {
        if (!(data.id in prev)) return prev;
        const next = { ...prev };
        delete next[data.id];
        return next;
      });
    });
    socket.on('incident:nearby', (data) => {
      if (data.deviceId === deviceId) {
        showWarning(data.message);
        soundsRef.current.playWarningSound();
      }
    });

    // RF-ALR-11 - parada preventiva colectiva
    socket.on('fleet:preventive_stop', (data) => {
      showDanger(data.message);
      soundsRef.current.playDangerSound(data.loop);
    });
    socket.on('fleet:preventive_stop_clear', (data) => {
      clearAlertState();
      soundsRef.current.stopSound();
      showWarning(data.message);
      setTimeout(clearAlertState, 5000);
    });

    return () => {
      socket.disconnect();
    };
  }, [deviceId]);

  // Detección local de desconexión prolongada - corre siempre que
  // haya un vehículo registrado, sin depender de que el socket esté
  // vivo (es justamente el caso que cubre: socket caído).
  useEffect(() => {
    if (!deviceId) return;

    const interval = setInterval(() => {
      if (disconnectedAtRef.current === null) return;
      const elapsed = Date.now() - disconnectedAtRef.current;

      if (elapsed >= LOCAL_DISCONNECT_LEVEL2_MS && localSignalLevelRef.current !== 'level2') {
        localSignalLevelRef.current = 'level2';
        setAlert({
          severity: 'danger',
          message: 'SIN CONEXIÓN PROLONGADA - DETÉNGASE Y REPORTE POR RADIO',
        });
        playDangerSound(true);
      } else if (elapsed >= LOCAL_DISCONNECT_LEVEL1_MS && localSignalLevelRef.current === 'none') {
        localSignalLevelRef.current = 'level1';
        setAlert({ severity: 'warning', message: 'SIN CONEXIÓN - REDUZCA VELOCIDAD' });
        playWarningSound();
      }
    }, 1000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- playWarningSound/playDangerSound son estables por render (ver useAlertSound), no hace falta re-suscribir el interval por ellas
  }, [deviceId]);

  const activeCount = Object.keys(fleet).length;

  return {
    connected,
    fleet,
    geofences,
    equipment,
    activeMaps,
    myPosition,
    myOnline,
    alert,
    activeCount,
    nearestVehicle,
    threat,
    activeGeofenceId,
    incidents,
  };
}
