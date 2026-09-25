import type { Geofence } from '@gaga-gps/shared-types';
import { useEffect, useRef, useState } from 'react';
import { evaluateGeofencesOffline, isInsideAllowedZone, type OfflineGeofenceMatch } from './offlineGeofences';
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
// futuro (pedido explicito). Lo que SI queda 100% en la tableta es la decision de que mostrar/sonar
// en pantalla (`pickAlert`/`setAlert` de abajo) - eso nunca depende de si el evento se reporto.
//
// Velocidad: distinto criterio, sin cambios - solo el exceso real (danger) deja registro, el aviso
// al 90% es para corregir a tiempo y no genera ni evento ni infraccion.
//
// Zona restringida: el servidor le manda a la tableta la REGLA (devices.restricted_to_allowed_zone,
// via el evento de socket device:config - ver useOperatorSocket.ts), cacheada localmente para que
// siga vigente sin conexion. La tableta evalua "¿estoy afuera de 'allowed' ahora mismo?" por NIVEL,
// no por transicion (mismo criterio ya corregido en el backend - un dispositivo restringido que
// arranca ya afuera debe alertar de inmediato, no solo el que "sale"), y reporta el cambio via
// device-events (kind: 'restricted_zone') - el servidor solo registra/difunde, no vuelve a decidir.
// Restringido + CERO geocercas 'allowed' en el proyecto = SIEMPRE violando (pedido explicito) - no
// hay ninguna zona valida en la que estar, asi que "afuera" es el unico estado posible.

export interface LocalAlert {
  severity: 'warning' | 'danger' | 'info';
  message: string;
  source: 'geofence' | 'speed' | 'restricted_zone';
  geofenceId: number | null;
}

const RESTRICTED_ZONE_MESSAGE = 'FUERA DE ZONA PERMITIDA - REGRESE DE INMEDIATO';

// el fix propio puede llegar a 10Hz; una transicion de zona o de limite no necesita esa frecuencia
const EVALUATION_INTERVAL_MS = 500;

// zonas donde una tableta puede quedarse sin señal sin que sea un problema (estacionada)
const EXEMPT_ZONE_TYPES = new Set(['allowed', 'parking']);

export interface LocalFixInput {
  latitude: number;
  longitude: number;
  speedKmh: number;
}

// el sonido lo dispara la propia tableta, no el eco del servidor (ver device-events.routes.ts):
// asi suena en el instante en que ella decide, y sigue sonando igual sin conexion
export interface AlertSounds {
  playWarningSound: () => void;
  playDangerSound: (loop?: boolean) => void;
  stopSound: () => void;
}

export function useLocalAlerts(
  deviceId: string | null,
  geofences: Geofence[],
  fix: LocalFixInput | null,
  limits: SpeedLimits = NO_SPEED_LIMITS,
  connected = false,
  sounds?: AlertSounds,
  restrictedToAllowedZone = false,
  geofencesReady = false,
) {
  const [alert, setAlert] = useState<LocalAlert | null>(null);

  const geofenceRef = useRef<OfflineGeofenceMatch | null>(null);
  const speedSeverityRef = useRef<'warning' | 'danger' | null>(null);
  const inAllowedZoneRef = useRef(false);
  // por NIVEL ("¿esta violando ahora mismo?"), no por transicion - mismo criterio que el fix del
  // backend (GeofenceAlertService.activeRestrictedViolations)
  const restrictedViolatingRef = useRef(false);
  const lastEvalAtRef = useRef(0);
  const alertSeverityRef = useRef<'warning' | 'danger' | 'info' | null>(null);
  const soundsRef = useRef(sounds);
  soundsRef.current = sounds;
  const geofencesRef = useRef(geofences);
  geofencesRef.current = geofences;
  const limitsRef = useRef(limits);
  limitsRef.current = limits;
  const restrictedRef = useRef(restrictedToAllowedZone);
  restrictedRef.current = restrictedToAllowedZone;
  const geofencesReadyRef = useRef(geofencesReady);
  geofencesReadyRef.current = geofencesReady;

  // al recuperar red se vacia lo que se haya acumulado sin conexion
  useEffect(() => {
    if (connected) void flushDeviceEvents();
  }, [connected]);

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

    // --- geocercas ---
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
      // solo el exceso real (danger) deja registro - el aviso al 90% es para corregir a tiempo,
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

    // en pantalla gana lo mas grave de las tres evaluaciones
    const next = pickAlert(match, speed.severity, speed.message, restrictedViolatingRef.current);
    setAlert(next);

    // el sonido solo cambia cuando cambia la severidad, no en cada evaluacion - si no, el pitido
    // se reiniciaria dos veces por segundo y nunca llegaria a sonar completo
    const previousSeverity = alertSeverityRef.current;
    if (next?.severity !== previousSeverity) {
      alertSeverityRef.current = next?.severity ?? null;
      if (next?.severity === 'danger') soundsRef.current?.playDangerSound(true);
      else if (next?.severity === 'warning') soundsRef.current?.playWarningSound();
      else soundsRef.current?.stopSound();
    }
  }, [deviceId, fix, connected]);

  return alert;
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

function pickAlert(
  match: OfflineGeofenceMatch | null,
  speedSeverity: 'warning' | 'danger' | null,
  speedMessage: string,
  restrictedViolating: boolean,
): LocalAlert | null {
  // zona restringida siempre es 'danger' - gana sobre cualquier warning, pero se compara igual
  // contra el resto para que un peligro real (danger de geocerca/velocidad) no quede opacado
  if (restrictedViolating) {
    return {
      severity: 'danger',
      message: RESTRICTED_ZONE_MESSAGE,
      source: 'restricted_zone',
      geofenceId: null,
    };
  }

  const rank = { info: 1, warning: 2, danger: 3 } as const;
  const geofenceRank = match ? rank[match.severity] : 0;
  const speedRank = speedSeverity ? rank[speedSeverity] : 0;

  if (speedRank > 0 && speedRank >= geofenceRank) {
    return { severity: speedSeverity!, message: speedMessage, source: 'speed', geofenceId: null };
  }
  if (match) {
    return {
      severity: match.severity,
      message: match.message,
      source: 'geofence',
      geofenceId: match.geofenceId,
    };
  }
  return null;
}
