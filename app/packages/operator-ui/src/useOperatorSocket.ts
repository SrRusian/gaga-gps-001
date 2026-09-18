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
import { evaluateGeofencesOffline, type OfflineGeofenceMatch } from './offlineGeofences';
import {
  cacheGeofences,
  dropSentAlerts,
  loadCachedGeofences,
  loadQueuedAlerts,
  queueOfflineAlert,
} from './offlineStore';
import { createApiClient, getStoredToken } from '@gaga-gps/client';

const api = createApiClient({ getToken: getStoredToken });

// cuantas alertas sin conexion se mandan por peticion - debe coincidir con MAX_OFFLINE_BATCH del
// backend (alerts.routes.ts). No limita el total: se repite hasta vaciar la cola entera.
const OFFLINE_ALERT_BATCH = 500;

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

const LOCAL_DISCONNECT_LEVEL1_MS = 10000;
const LOCAL_DISCONNECT_LEVEL2_MS = 20000;

export interface LocalFix {
  latitude: number;
  longitude: number;
}

export function useOperatorSocket(deviceId: string | null, localFix?: LocalFix | null) {
  const [connected, setConnected] = useState(false);
  const [fleet, setFleet] = useState<Record<string, Position>>({});
  // se hidrata del cache local antes de que exista socket - asi la tableta abre con sus geocercas
  // ya dibujadas y evaluables aunque arranque sin red (pedido explicito: el Operador debe poder
  // operar sin restricciones sin conexion)
  const [geofences, setGeofences] = useState<Geofence[]>(() => loadCachedGeofences());
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
  const { playWarningSound, playDangerSound, stopSound } = useAlertSound();
  const soundsRef = useRef({ playWarningSound, playDangerSound, stopSound });
  soundsRef.current = { playWarningSound, playDangerSound, stopSound };

  const disconnectedAtRef = useRef<number | null>(null);
  const localSignalLevelRef = useRef<'none' | 'level1' | 'level2'>('none');
  const powerSuspendedRef = useRef(false);
  // geocerca que el motor local tiene activa ahora mismo (solo sin conexion) - declarada aqui
  // arriba porque el vigilante de desconexion, mas abajo, no debe pisar una alerta de zona real
  const offlineMatchRef = useRef<OfflineGeofenceMatch | null>(null);

  useEffect(() => {
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
      cacheGeofences(gs); // sobreviven a cerrar la app y a quedarse sin red
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
    // vehiculo afectado le llega en primera persona via un evento dirigido solo a el, al resto del
    // proyecto en tercera persona ("VEHICULO X SIN SEÑAL") por seguridad - aqui solo se muestra
    // el que de verdad llego, sin filtrar de nuevo
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
      // una zona de riesgo real detectada en local pesa mas que el aviso de "sin conexion" - el
      // nivel se sigue actualizando abajo, solo no se pisa lo que se ve en pantalla
      const holdForGeofence = offlineMatchRef.current !== null;
      const elapsed = Date.now() - disconnectedAtRef.current;

      if (elapsed >= LOCAL_DISCONNECT_LEVEL2_MS && localSignalLevelRef.current !== 'level2') {
        localSignalLevelRef.current = 'level2';
        if (holdForGeofence) return;
        setAlert({
          severity: 'danger',
          message: 'SIN CONEXIÓN PROLONGADA - DETÉNGASE Y REPORTE POR RADIO',
        });
        playDangerSound(true);
      } else if (elapsed >= LOCAL_DISCONNECT_LEVEL1_MS && localSignalLevelRef.current === 'none') {
        localSignalLevelRef.current = 'level1';
        if (holdForGeofence) return;
        setAlert({ severity: 'warning', message: 'SIN CONEXIÓN - REDUZCA VELOCIDAD' });
        playWarningSound();
      }
    }, 1000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  // Evaluacion local de geocercas: SOLO mientras no hay socket. Con conexion manda el backend sin
  // excepcion (regla ya documentada: la alerta la decide el servidor para que el HUD del operador y
  // el panel del supervisor nunca disientan) - esto existe para que perder la red no deje al
  // operador sin avisos de zona, y para no perder el registro de lo que ocurrio mientras tanto.
  const geofencesRef = useRef<Geofence[]>(geofences);
  geofencesRef.current = geofences;
  const lastOfflineEvalAtRef = useRef(0);

  useEffect(() => {
    if (!deviceId) return;

    if (connected) {
      // el servidor retoma el mando: se suelta cualquier alerta que hubiera puesto el motor local,
      // para no dejar en pantalla un estado que el backend ya no respalda
      if (offlineMatchRef.current) {
        offlineMatchRef.current = null;
        setAlert({ severity: null, message: '' });
        soundsRef.current.stopSound();
      }
      return;
    }

    if (!localFix) return;
    // el fix propio puede llegar a 10Hz - una transicion de geocerca no necesita esa frecuencia, y
    // evaluar cada poligono 10 veces por segundo gastaria bateria sin aportar nada
    const now = Date.now();
    if (now - lastOfflineEvalAtRef.current < 500) return;
    lastOfflineEvalAtRef.current = now;

    const match = evaluateGeofencesOffline(
      localFix.latitude,
      localFix.longitude,
      geofencesRef.current,
    );
    const previous = offlineMatchRef.current;
    if ((match?.geofenceId ?? null) === (previous?.geofenceId ?? null)) return;

    const base = {
      deviceId,
      latitude: localFix.latitude,
      longitude: localFix.longitude,
      occurredAt: new Date().toISOString(),
    };

    if (previous) {
      queueOfflineAlert({
        ...base,
        geofenceId: previous.geofenceId,
        geofenceName: previous.geofenceName,
        severity: previous.severity,
        message: `SALIO DE "${previous.geofenceName}"`,
        event: 'exit',
      });
    }

    offlineMatchRef.current = match;

    if (match) {
      queueOfflineAlert({
        ...base,
        geofenceId: match.geofenceId,
        geofenceName: match.geofenceName,
        severity: match.severity,
        message: match.message,
        event: 'enter',
      });
      setAlert({ severity: match.severity, message: match.message });
      if (match.severity === 'danger') soundsRef.current.playDangerSound(true);
      else if (match.severity === 'warning') soundsRef.current.playWarningSound();
    } else {
      setAlert({ severity: null, message: '' });
      soundsRef.current.stopSound();
      // seguimos sin red: el aviso de desconexion vuelve a ser lo relevante en pantalla
      if (localSignalLevelRef.current === 'level2') {
        setAlert({ severity: 'danger', message: 'SIN CONEXIÓN PROLONGADA - DETÉNGASE Y REPORTE POR RADIO' });
      } else if (localSignalLevelRef.current === 'level1') {
        setAlert({ severity: 'warning', message: 'SIN CONEXIÓN - REDUZCA VELOCIDAD' });
      }
    }
  }, [connected, localFix, deviceId]);

  // al recuperar red se vacia la cola entera, en tandas, sin limite de cuantas - lo que se genero
  // sin conexion tiene que quedar registrado en el servidor si o si (pedido explicito)
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;

    (async () => {
      while (!cancelled) {
        const queued = loadQueuedAlerts();
        if (queued.length === 0) return;
        const batch = queued.slice(0, OFFLINE_ALERT_BATCH);
        try {
          await api.post('/api/alerts/offline-batch', { alerts: batch });
          dropSentAlerts(batch.length);
        } catch {
          return; // se reintenta solo en la proxima reconexion, sin perder nada
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connected]);

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
  };
}
