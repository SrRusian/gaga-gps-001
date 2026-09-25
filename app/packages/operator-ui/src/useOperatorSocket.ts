import { createSocket } from '@gaga-gps/client';
import { AppUpdate, Power } from '@gaga-gps/android-bridge';
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
import {
  cacheGeofences,
  cacheRestrictedToAllowedZone,
  loadCachedGeofences,
  loadCachedRestrictedToAllowedZone,
  loadGeofencesReady,
} from './offlineStore';

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

// distancia al vehiculo mas cercano EN LA MISMA RUTA autorizada - independiente de NearestVehicle
// (radar generico de toda el area, que ademas excluye vehiculos dentro de una ruta) - ver
// CollisionRiskService._updateRouteDistance
export interface NearestOnRouteVehicle {
  deviceId: string;
  distanceMeters: number;
  routeName: string;
}

export interface ThreatVehicle {
  deviceId: string;
  distance: number;
}

// aviso silencioso de proximidad a geocerca peligrosa - deliberadamente separado del slot `alert`
// de arriba (nunca se persiste, nunca lo ve nadie mas que este operador) para que un
// alert:proximity_clear no pueda borrar por accidente una alerta real (critica/warning) que ya
// este en pantalla - ver GeofenceAlertService._evaluateSilentTier
export interface ProximityNotice {
  distanceMeters: number;
  message: string;
}

// aviso de conectividad de OTRO vehiculo (senal perdida/recuperada de un tercero) - separado a
// proposito del slot `alert` de arriba. Bug real reportado: el mismo evento signal:lost:levelX que
// el backend manda en tercera persona a todo el proyecto ("VEHICULO X SIN SEÑAL") se procesaba
// aqui sin filtrar por deviceId, así que sobreescribia (visualmente Y en el sonido - useAlertSound
// corta cualquier sonido en curso antes de tocar uno nuevo) una alerta real y propia que ya
// estuviera en pantalla/sonando. Este es solo un aviso de precaucion sobre alguien mas - nunca debe
// competir con el overlay/sonido de un peligro real de ESTE vehiculo
export interface NetworkNotice {
  severity: 'warning' | 'danger';
  message: string;
  deviceId: string;
}

// mismos umbrales que SignalLostService del backend (5s/15s) - no es codigo compartido, es el mismo
// criterio a proposito: el operador se entera de que perdio conexion al mismo tiempo que el resto
// del proyecto. Ademas, estando sin red este vigilante local es el UNICO que puede aplicarle el
// alto total a este vehiculo - el servidor ya no detiene a toda la flota por una tableta caida
const LOCAL_DISCONNECT_LEVEL1_MS = 5000;
const LOCAL_DISCONNECT_LEVEL2_MS = 15000;

export function useOperatorSocket(deviceId: string | null) {
  const [connected, setConnected] = useState(false);
  const [fleet, setFleet] = useState<Record<string, Position>>({});
  // se hidrata del cache local antes de que exista socket - asi la tableta abre con sus geocercas
  // ya dibujadas y evaluables aunque arranque sin red (pedido explicito: el Operador debe poder
  // operar sin restricciones sin conexion)
  const [geofences, setGeofences] = useState<Geofence[]>(() => loadCachedGeofences());
  // ver offlineStore.ts - distingue "nunca llego un geofences:update real" de "llego y esta vacio"
  const [geofencesReady, setGeofencesReady] = useState(() => loadGeofencesReady());
  // "el servidor le dice al dispositivo la regla, no al reves" - se hidrata del cache local igual
  // que las geocercas (funciona sin red desde el arranque) y se actualiza via device:config, que
  // llega al conectar y en cuanto un admin cambia el valor (ver useLocalAlerts.ts, que la usa para
  // evaluar la violacion 100% local)
  const [restrictedToAllowedZone, setRestrictedToAllowedZone] = useState(() =>
    loadCachedRestrictedToAllowedZone(),
  );
  const [equipment, setEquipment] = useState<EquipmentMarkerData[]>([]);
  const [activeMaps, setActiveMaps] = useState<ActiveMap[]>([]);
  const [myPosition, setMyPosition] = useState<Position | null>(null);
  const [myOnline, setMyOnline] = useState(false);
  const [alert, setAlert] = useState<AlertState>({ severity: null, message: '' });
  const [nearestVehicle, setNearestVehicle] = useState<NearestVehicle | null>(null);
  const [nearestOnRoute, setNearestOnRoute] = useState<NearestOnRouteVehicle | null>(null);
  const [threat, setThreat] = useState<ThreatVehicle | null>(null);
  const [activeGeofenceId, setActiveGeofenceId] = useState<number | null>(null);
  const [incidents, setIncidents] = useState<Record<number, IncidentReportedPayload>>({});
  const [proximityNotice, setProximityNotice] = useState<ProximityNotice | null>(null);
  const [networkNotice, setNetworkNotice] = useState<NetworkNotice | null>(null);
  const { playWarningSound, playDangerSound, stopSound } = useAlertSound();
  const soundsRef = useRef({ playWarningSound, playDangerSound, stopSound });
  soundsRef.current = { playWarningSound, playDangerSound, stopSound };

  const disconnectedAtRef = useRef<number | null>(null);
  const localSignalLevelRef = useRef<'none' | 'level1' | 'level2'>('none');
  const powerSuspendedRef = useRef(false);

  useEffect(() => {
    if (!deviceId) return;

    const socket = createSocket();

    const showWarning = (message: string) => setAlert({ severity: 'warning', message });
    const showDanger = (message: string) => setAlert({ severity: 'danger', message });
    const showInfo = (message: string) => setAlert({ severity: 'info', message });
    const clearAlertState = () => setAlert({ severity: null, message: '' });
    // colision/proximidad se emiten SIN filtro de proyecto en el backend (gap de aislamiento ya
    // documentado, io.emit global) - sin este chequeo, cualquier par de vehiculos en TODO el
    // sistema podia hijackear el overlay/sonido de este operador. deviceId1/deviceId2 llegan como
    // number en CollisionPayload (typo historico, en runtime son strings) - String() normaliza los
    // dos casos con la misma funcion
    const involvesMe = (a: string | number, b: string | number) =>
      String(a) === deviceId || String(b) === deviceId;

    socket.on('connect', () => {
      setConnected(true);
      disconnectedAtRef.current = null;
      if (localSignalLevelRef.current !== 'none') {
        localSignalLevelRef.current = 'none';
        clearAlertState();
        soundsRef.current.stopSound();
      }
      // unico dato que le permite al backend mandarle un evento a ESTA tableta en particular
      // (ver FleetSocketServer.sendToDevice / "Actualizar esta tableta" en el panel de Sistema)
      socket.emit('device:hello', { deviceId });
    });
    socket.on('disconnect', () => {
      setConnected(false);
      setMyOnline(false);
      disconnectedAtRef.current = Date.now();
    });

    // el admin pidio "actualizar ahora" desde el panel - solo llega si el socket esta conectado
    // en este momento, ver la nota en FleetSocketServer.sendToDevice sobre esa limitacion real
    socket.on('device:force_update', () => {
      AppUpdate.checkNow().catch(() => {});
    });

    socket.on('maps:active_update', ({ maps }) => setActiveMaps(maps));
    socket.on('geofences:update', (gs) => {
      setGeofences(gs);
      setGeofencesReady(true);
      cacheGeofences(gs); // sobreviven a cerrar la app y a quedarse sin red
    });
    socket.on('device:config', (data: { restrictedToAllowedZone?: boolean }) => {
      if (typeof data.restrictedToAllowedZone !== 'boolean') return;
      setRestrictedToAllowedZone(data.restrictedToAllowedZone);
      cacheRestrictedToAllowedZone(data.restrictedToAllowedZone);
    });
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

    // canal propio del aviso silencioso - solo llega dirigido a este dispositivo (sendToDevice), sin
    // sonido, sin tocar el slot `alert` real (ver comentario de ProximityNotice arriba)
    socket.on('alert:proximity_notice', (data) => {
      setProximityNotice({
        distanceMeters: data.distanceMeters,
        message: data.message,
      });
    });
    socket.on('alert:proximity_clear', () => setProximityNotice(null));

    socket.on('route:distance_update', (data) => {
      setNearestOnRoute({
        deviceId: data.nearestDeviceId,
        distanceMeters: data.distanceMeters,
        routeName: data.routeName,
      });
    });
    socket.on('route:distance_clear', () => setNearestOnRoute(null));

    // el backend ya decide el mensaje segun la audiencia (SignalLostService.ts): al propio
    // vehiculo afectado le llega en primera persona via un evento dirigido solo a el (sendToDevice),
    // al resto del proyecto en tercera persona ("VEHICULO X SIN SEÑAL") por seguridad
    // (broadcastToProjectExceptDevice) - MISMO nombre de evento en los dos casos. Bug real: antes
    // esto se mostraba siempre en el overlay/sonido principal sin distinguir de quien se trataba, asi
    // que el aviso de que un vehiculo AJENO perdio señal podia tapar (visual y auditivamente) una
    // alerta real y propia. Ahora: si es sobre este vehiculo, sigue siendo el overlay/sonido
    // principal de siempre (es un peligro real para mi); si es sobre otro, va al canal de aviso de
    // red (silencioso, banner aparte) - ver NetworkNotice arriba
    socket.on('signal:lost:level1', (data) => {
      if (data.deviceId === deviceId) {
        showWarning(data.message);
        soundsRef.current.playWarningSound();
      } else {
        setNetworkNotice({ severity: 'warning', message: data.message, deviceId: data.deviceId });
      }
    });
    socket.on('signal:lost:level2', (data) => {
      if (data.deviceId === deviceId) {
        showDanger(data.message);
        soundsRef.current.playDangerSound(data.loop);
      } else {
        setNetworkNotice({ severity: 'danger', message: data.message, deviceId: data.deviceId });
      }
    });
    socket.on('signal:recovered', (data) => {
      if (data.deviceId === deviceId) {
        clearAlertState();
        soundsRef.current.stopSound();
      } else {
        // solo limpia si el aviso activo es justo de ESE vehiculo - la recuperacion de uno no debe
        // borrar un aviso de red vigente sobre otro vehiculo distinto todavia caido
        setNetworkNotice((prev) => (prev?.deviceId === data.deviceId ? null : prev));
      }
    });

    socket.on('collision:proximity', (data) => {
      if (!involvesMe(data.deviceId1, data.deviceId2)) return;
      showWarning(data.message);
      soundsRef.current.playWarningSound();
    });
    socket.on('collision:critical', (data) => {
      if (!involvesMe(data.deviceId1, data.deviceId2)) return;
      showDanger(data.message);
      soundsRef.current.playDangerSound(data.loop);
      const otherId = String(data.deviceId1) === deviceId ? data.deviceId2 : data.deviceId1;
      setThreat({ deviceId: String(otherId), distance: data.distance });
    });
    socket.on('collision:clear', (data) => {
      if (!involvesMe(data.deviceId1, data.deviceId2)) return;
      clearAlertState();
      soundsRef.current.stopSound();
      setThreat(null);
    });

    socket.on('proximity:distance_update', (data) => {
      if (data.deviceId === deviceId) {
        setNearestVehicle({ deviceId: data.nearestDeviceId, distance: data.distance });
      }
    });
    socket.on('proximity:warning', (data) => {
      if (!involvesMe(data.deviceId1, data.deviceId2)) return;
      showWarning(data.message);
      soundsRef.current.playWarningSound();
    });
    socket.on('proximity:critical', (data) => {
      if (!involvesMe(data.deviceId1, data.deviceId2)) return;
      showDanger(data.message);
      soundsRef.current.playDangerSound(data.loop);
      const otherId = data.deviceId1 === deviceId ? data.deviceId2 : data.deviceId1;
      setThreat({ deviceId: otherId, distance: data.distance });
    });
    socket.on('proximity:clear', (data) => {
      if (!involvesMe(data.deviceId1, data.deviceId2)) return;
      clearAlertState();
      soundsRef.current.stopSound();
      setThreat(null);
      setNearestVehicle(null);
    });

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

    // suspension por perdida de corriente (ver power/PowerSuspendAlarmReceiver.kt) - GPS/RTK/
    // pantalla ya se apagan del lado nativo, pero sin esto el socket seguia conectado y
    // procesando alertas/posiciones de toda la flota en segundo plano - bug real reportado en
    // campo ("se apago la pantalla pero de fondo se estan escuchando las alertas igual"). Se
    // desconecta/reconecta el mismo socket (conserva sus listeners) en vez de crear uno nuevo.
    // Desconectar el socket solo evita eventos NUEVOS - una alerta ya sonando (ej. parada
    // preventiva activa desde antes de perder corriente) sigue sonando si no se detiene aparte,
    // por eso tambien se limpia el estado/sonido activo al entrar en suspension (bug real
    // reportado: "hay un alto total activo... se sigue escuchando la alerta de fondo").
    function onPowerSuspended() {
      powerSuspendedRef.current = true;
      socket.disconnect();
      clearAlertState();
      soundsRef.current.stopSound();
    }
    Power.getStatus().then((status) => {
      if (status.suspended) onPowerSuspended();
    });
    const powerListenerPromise = Power.addListener('powerStatus', (status) => {
      if (status.suspended) {
        onPowerSuspended();
      } else {
        powerSuspendedRef.current = false;
        if (!socket.connected) socket.connect();
      }
    });

    return () => {
      powerListenerPromise.then((h) => h.remove());
      socket.disconnect();
    };
  }, [deviceId]);

  useEffect(() => {
    if (!deviceId) return;

    const interval = setInterval(() => {
      // desconexion intencional por suspension de energia (power/PowerSuspendAlarmReceiver.kt) -
      // no es perdida real de senal, este vigilante local no debe disparar su propia alerta
      // mientras dure (bug real: "sin conexion prolongada" sonando de fondo tras la suspension)
      if (powerSuspendedRef.current) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  // La evaluacion de geocercas y velocidad ya NO vive aqui: la hace useLocalAlerts, siempre, con o
  // sin conexion, y le reporta al servidor lo que decide (ver device-events.routes.ts). Este hook
  // se queda solo con lo que el servidor si es quien debe decidir porque necesita ver a TODA la
  // flota: colision, proximidad, equipo estatico, incidentes, parada preventiva y señal perdida.

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
    nearestOnRoute,
    threat,
    activeGeofenceId,
    incidents,
    proximityNotice,
    networkNotice,
    restrictedToAllowedZone,
    geofencesReady,
    // la evaluacion local (useLocalAlerts) suena por su cuenta, compartiendo esta MISMA instancia:
    // dos useAlertSound distintos tendrian cada uno su propio bucle y ninguno podria callar al otro
    sounds: { playWarningSound, playDangerSound, stopSound },
  };
}
