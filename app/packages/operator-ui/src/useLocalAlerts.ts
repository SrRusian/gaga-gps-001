import type { Geofence } from '@gaga-gps/shared-types';
import { useEffect, useRef, useState } from 'react';
import {
  evaluateGeofencesOffline,
  isInsideAllowedZone,
  matchedInformativeGeofences,
  GEOFENCE_TYPE_LABEL,
  type OfflineGeofenceMatch,
} from './offlineGeofences';
import { evaluateSpeed, NO_SPEED_LIMITS, type SpeedLimits } from './localSpeed';
import { flushDeviceEvents, reportDeviceEvent, type DeviceEvent } from './deviceEvents';

// La tableta evalua geocercas y velocidad por su cuenta, SIEMPRE - con o sin conexion - y le
// reporta al servidor lo que decide. Es la inversion de la regla vieja ("la alerta la decide el
// backend"): ahora el Operador es la fuente de verdad y el servidor registra, organiza, levanta la
// infraccion y se lo cuenta a los demas. Motivo: sin conexion el servidor no puede decidir nada, y
// un vehiculo no puede quedarse sin avisos por un bache de cobertura.
//
// Solo se evalua lo que la tableta puede resolver sola con datos que ya tiene en mano. Lo que
// necesita comparar contra OTROS vehiculos (colision, proximidad) o contra geometria pesada de
// PostGIS (zona restringida, tiers elasticos de acercamiento) lo sigue decidiendo el servidor.
//
// Geocercas: TODA transicion (entrar/salir) se reporta al servidor sin importar severidad - el
// servidor guarda el historial completo en geofence_events para poder calcular tiempo en zona a
// futuro (pedido explicito). Lo que SI queda 100% en la tableta es la decision de que mostrar en
// pantalla (`alerts`/`toast` de abajo) - eso nunca depende de si el evento se reporto.
//
// Velocidad: distinto criterio, sin cambios - solo el exceso real (danger) deja registro, el aviso
// al 75% es para corregir a tiempo y no genera ni evento ni infraccion.
//
// Zona restringida: el servidor le manda a la tableta la REGLA (devices.restricted_to_allowed_zone,
// via el evento de socket device:config - ver useOperatorSocket.ts), cacheada localmente para que
// siga vigente sin conexion. La tableta evalua "¿estoy afuera de 'allowed' ahora mismo?" por NIVEL,
// no por transicion (mismo criterio ya corregido en el backend - un dispositivo restringido que
// arranca ya afuera debe alertar de inmediato, no solo el que "sale"), y reporta el cambio via
// device-events (kind: 'restricted_zone') - el servidor solo registra/difunde, no vuelve a decidir.
// Restringido + CERO geocercas 'allowed' en el proyecto = SIEMPRE violando (pedido explicito) - no
// hay ninguna zona valida en la que estar, asi que "afuera" es el unico estado posible.
//
// Las 3 condiciones (zona restringida/geocerca de atencion/velocidad) pueden estar activas A LA VEZ
// - pedido explicito: "múltiples alertas puedan convivir... poder ver las 3 alertas que hay". Este
// hook ya no elige un solo ganador (antes `pickAlert`) - devuelve TODAS las que apliquen, y quien
// arma el sonido/la pantalla (OperatorApp.tsx, junto con lo que decide el servidor) es quien decide
// cual suena, con el sistema de prioridad de alertPriority.ts.

export interface LocalAlert {
  severity: 'warning' | 'danger';
  message: string;
  source: 'geofence' | 'speed' | 'restricted_zone';
  geofenceId: number | null;
}

// aviso "Entrando a/Saliendo de zona X" - transitorio, sin sonido, distinto de LocalAlert a
// proposito (nunca compite por prioridad ni por el slot de sonido, ver GeofenceToast en
// OperatorApp.tsx). Se auto-limpia solo tras TOAST_DURATION_MS.
export interface GeofenceToast {
  message: string;
}

const RESTRICTED_ZONE_MESSAGE = 'FUERA DE ZONA PERMITIDA - REGRESE DE INMEDIATO';

// el fix propio puede llegar a 10Hz; una transicion de zona o de limite no necesita esa frecuencia
const EVALUATION_INTERVAL_MS = 500;

// zonas donde una tableta puede quedarse sin señal sin que sea un problema (estacionada)
const EXEMPT_ZONE_TYPES = new Set(['allowed', 'parking']);

// tiempo que el aviso de entrar/salir de zona informativa queda en pantalla antes de desvanecerse
const TOAST_DURATION_MS = 4500;

export interface LocalFixInput {
  latitude: number;
  longitude: number;
  speedKmh: number;
}

export function useLocalAlerts(
  deviceId: string | null,
  geofences: Geofence[],
  fix: LocalFixInput | null,
  limits: SpeedLimits = NO_SPEED_LIMITS,
  connected = false,
  restrictedToAllowedZone = false,
  geofencesReady = false,
) {
  const [alerts, setAlerts] = useState<LocalAlert[]>([]);
  const [toast, setToast] = useState<GeofenceToast | null>(null);

  const geofenceRef = useRef<OfflineGeofenceMatch | null>(null);
  const speedSeverityRef = useRef<'warning' | 'danger' | null>(null);
  const inAllowedZoneRef = useRef(false);
  // por NIVEL ("¿esta violando ahora mismo?"), no por transicion - mismo criterio que el fix del
  // backend (GeofenceAlertService.activeRestrictedViolations)
  const restrictedViolatingRef = useRef(false);
  const lastEvalAtRef = useRef(0);
  const geofencesRef = useRef(geofences);
  geofencesRef.current = geofences;
  const limitsRef = useRef(limits);
  limitsRef.current = limits;
  const restrictedRef = useRef(restrictedToAllowedZone);
  restrictedRef.current = restrictedToAllowedZone;
  const geofencesReadyRef = useRef(geofencesReady);
  geofencesReadyRef.current = geofencesReady;
  // ultimo set de geocercas informativas activas, por id - para diferenciar entrada/salida en el
  // siguiente tick sin volver a evaluar contra "la geocerca actual" (aqui puede haber varias a la
  // vez, a diferencia de geofenceRef que solo guarda la de atencion mas severa)
  const informativeSetRef = useRef<Map<number, Geofence>>(new Map());
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // al recuperar red se vacia lo que se haya acumulado sin conexion
  useEffect(() => {
    if (connected) void flushDeviceEvents();
  }, [connected]);

  useEffect(
    () => () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!deviceId || !fix) return;
    const now = Date.now();
    if (now - lastEvalAtRef.current < EVALUATION_INTERVAL_MS) return;
    lastEvalAtRef.current = now;

    const base = {
      deviceId,
      latitude: fix.latitude,
      longitude: fix.longitude,
      occurredAt: new Date().toISOString(),
    };
    const send = (event: DeviceEvent) => void reportDeviceEvent(event);

    // --- geocercas de atencion ---
    const match = evaluateGeofencesOffline(fix.latitude, fix.longitude, geofencesRef.current);
    const previous = geofenceRef.current;
    const changed = (match?.geofenceId ?? null) !== (previous?.geofenceId ?? null);

    if (changed) {
      // toda transicion se reporta, sin importar severidad - el servidor necesita el historial
      // completo (entrada/salida) para calcular tiempo en zona a futuro
      if (previous) {
        send({
          ...base,
          kind: 'geofence',
          state: 'cleared',
          severity: previous.severity,
          message: `SALIÓ DE "${previous.geofenceName}"`,
          geofenceId: previous.geofenceId,
          geofenceName: previous.geofenceName,
        });
      }
      if (match) {
        send({
          ...base,
          kind: 'geofence',
          state: 'raised',
          severity: match.severity,
          message: match.message,
          geofenceId: match.geofenceId,
          geofenceName: match.geofenceName,
        });
      }
      geofenceRef.current = match;
    }

    // --- zona exenta (estacionamiento/permitida) ---
    // independiente de la severidad de arriba: el servidor necesita saber esto para no alarmar al
    // proyecto si la tableta se queda sin señal justo despues, estando estacionada donde puede
    // estarlo - sin esto quedaria atado a que ademas ocurriera una alerta grave al mismo tiempo
    const inAllowedZone = isInExemptZone(fix, geofencesRef.current);
    if (inAllowedZone !== inAllowedZoneRef.current) {
      inAllowedZoneRef.current = inAllowedZone;
      send({ ...base, kind: 'zone_status', state: 'raised', severity: 'info', message: '', inAllowedZone });
    }

    // --- zona restringida ---
    // un solo punto de decision (nunca if/else-if con varias ramas) - "¿esta violando ahora mismo?"
    // se recalcula completo en cada tick elegible y se compara contra el valor anterior. Sin
    // geocercas cargadas todavia (geofencesReady=false, arranque en frio) cae a "no violando" -
    // seguro por default, se corrige solo en el siguiente tick en cuanto geofences:update llegue.
    // Restringido + CERO geocercas 'allowed' en el proyecto = SIEMPRE violando (pedido explicito:
    // no hay zona valida en la que estar, no depende de que exista ninguna)
    const currentlyViolating =
      restrictedRef.current && geofencesReadyRef.current
        ? !isInsideAllowedZone(fix.latitude, fix.longitude, geofencesRef.current)
        : false;
    if (currentlyViolating !== restrictedViolatingRef.current) {
      restrictedViolatingRef.current = currentlyViolating;
      send({
        ...base,
        kind: 'restricted_zone',
        state: currentlyViolating ? 'raised' : 'cleared',
        severity: 'danger',
        message: RESTRICTED_ZONE_MESSAGE,
      });
    }

    // --- velocidad ---
    const speed = evaluateSpeed(fix.speedKmh, limitsRef.current, matchedGeofence(match, geofencesRef.current));
    const previousSpeed = speedSeverityRef.current;
    if (speed.severity !== previousSpeed) {
      // solo el exceso real (danger) deja registro - el aviso al 75% es para corregir a tiempo,
      // no para acumularle una infraccion al operador
      if (speed.severity === 'danger') {
        send({
          ...base,
          kind: 'speed',
          state: 'raised',
          severity: 'danger',
          message: speed.message,
          speedKmh: Math.round(speed.speedKmh),
          limitKmh: speed.limitKmh,
        });
      } else if (previousSpeed === 'danger') {
        send({
          ...base,
          kind: 'speed',
          state: 'cleared',
          severity: 'danger',
          message: 'VELOCIDAD NORMALIZADA',
          speedKmh: Math.round(speed.speedKmh),
          limitKmh: speed.limitKmh,
        });
      }
      speedSeverityRef.current = speed.severity;
    }

    // --- se arma la lista completa de condiciones activas, sin elegir un solo ganador ---
    // (antes esto era pickAlert(), que se quedaba con una sola) - el orden aqui no importa, quien
    // consume esto (OperatorApp.tsx) ordena por prioridad real via alertPriority.ts
    const nextAlerts: LocalAlert[] = [];
    if (restrictedViolatingRef.current) {
      nextAlerts.push({
        severity: 'danger',
        message: RESTRICTED_ZONE_MESSAGE,
        source: 'restricted_zone',
        geofenceId: null,
      });
    }
    if (match) {
      nextAlerts.push({
        severity: match.severity,
        message: match.message,
        source: 'geofence',
        geofenceId: match.geofenceId,
      });
    }
    if (speed.severity) {
      nextAlerts.push({ severity: speed.severity, message: speed.message, source: 'speed', geofenceId: null });
    }
    setAlerts(nextAlerts);

    // --- aviso de entrar/salir de zona informativa (toast, sin sonido) ---
    // TODAS las informativas activas a la vez (puede haber varias encimadas/contiguas), no solo la
    // "actual" - se diferencia contra el set del tick anterior para saber que entro y que salio
    const currentInformative = matchedInformativeGeofences(fix.latitude, fix.longitude, geofencesRef.current);
    const currentMap = new Map(currentInformative.map((g) => [g.id, g] as const));
    const prevMap = informativeSetRef.current;
    const entered: Geofence[] = [];
    const exited: Geofence[] = [];
    currentMap.forEach((g, id) => {
      if (!prevMap.has(id)) entered.push(g);
    });
    prevMap.forEach((g, id) => {
      if (!currentMap.has(id)) exited.push(g);
    });
    informativeSetRef.current = currentMap;

    if (entered.length > 0 || exited.length > 0) {
      const parts: string[] = [];
      exited.forEach((g) => parts.push(`Saliendo de ${g.name}`));
      entered.forEach((g) => parts.push(`Entrando a ${g.name} (${GEOFENCE_TYPE_LABEL[g.type]})`));
      setToast({ message: parts.join(' - ') });
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = setTimeout(() => setToast(null), TOAST_DURATION_MS);
    }
  }, [deviceId, fix, connected]);

  return { alerts, toast };
}

function matchedGeofence(match: OfflineGeofenceMatch | null, geofences: Geofence[]): Geofence | null {
  if (!match) return null;
  return geofences.find((g) => g.id === match.geofenceId) ?? null;
}

// se evalua contra TODAS las zonas exentas, no solo la de mayor severidad: estar estacionado en un
// estacionamiento vale aunque encima haya una zona de precaucion
function isInExemptZone(fix: LocalFixInput, geofences: Geofence[]): boolean {
  const exempt = geofences.filter((g) => EXEMPT_ZONE_TYPES.has(g.type));
  if (exempt.length === 0) return false;
  return evaluateGeofencesOfflineAny(fix, exempt);
}

// evaluateGeofencesOffline solo considera tipos con severidad (allowed/parking no la tienen), asi
// que para saber "estoy dentro de esta zona" hay que preguntarlo aparte
function evaluateGeofencesOfflineAny(fix: LocalFixInput, geofences: Geofence[]): boolean {
  return geofences.some(
    (g) =>
      evaluateGeofencesOffline(fix.latitude, fix.longitude, [{ ...g, type: 'danger' }]) !== null,
  );
}
