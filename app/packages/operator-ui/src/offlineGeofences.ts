import type { Geofence, GeofenceType } from '@gaga-gps/shared-types';

// Evaluacion de geocercas del lado del cliente - la tableta es la unica que decide, SIEMPRE, con o
// sin conexion (ver useLocalAlerts.ts). El servidor solo notifica los cambios de geocerca en vivo
// (geofences:update) y registra lo que la tableta ya decidio; nunca vuelve a evaluar geometria.
//
// Duplicacion deliberada de backend/src/services/alerts/GeofenceAlertService.ts (tablas de
// severidad/texto, ya sin uso en produccion mas alla de referencia) y del WHERE de
// GeofenceRepository.findMatchingSpatial (las 5 ramas de forma) - shared-types no puede exportar
// valores reales, mismo criterio que PositionFilterService y GEOFENCE_COLORS. Si se cambia el
// criterio, replicar aqui.

// Dos categorias, no una escala continua - pedido explicito: "de atencion" (dispara la alerta
// sonora/visual de verdad) vs "informativa/aviso" (nunca alerta, solo el aviso silencioso de
// entrar/salir - ver matchedInformativeGeofences). `maintenance`/`parking` se reclasificaron aqui a
// informativas (antes generaban alerta) - la severidad la decide SIEMPRE el `type`, nunca la forma.
const AREA_SEVERITY: Partial<Record<GeofenceType, 'warning' | 'danger'>> = {
  danger: 'danger',
  forbidden: 'danger',
  warning: 'warning',
};

const AREA_ALERT_TEXT: Partial<Record<GeofenceType, string>> = {
  danger: 'PELIGRO - DETENER VEHÍCULO INMEDIATAMENTE',
  forbidden: 'ZONA PROHIBIDA - NO INGRESAR - DETENER VEHÍCULO',
  warning: 'PRECAUCIÓN - ZONA DE RIESGO - REDUCIR VELOCIDAD',
};

// aviso temprano (ver evaluateGeofencesNearby) - cuando el circulo de precision GPS ya toca el
// borde pero ni el punto ni la silueta real del vehiculo todavia. Siempre severidad 'warning', sin
// importar el tipo real de la zona (nunca mas grave que un heads-up de "podrias estar tocando ya")
const NEAR_ALERT_TEXT: Partial<Record<GeofenceType, string>> = {
  danger: 'PRECAUCIÓN - ACERCÁNDOSE A ZONA DE PELIGRO',
  forbidden: 'PRECAUCIÓN - ACERCÁNDOSE A ZONA PROHIBIDA',
  warning: 'PRECAUCIÓN - ACERCÁNDOSE A ZONA DE RIESGO',
};

// misma llave que AREA_SEVERITY (los unicos 3 tipos que disparan alerta real) - exportado para que
// matchedInformativeGeofences (todo lo demas) y el resto del arbol de alertas usen una sola fuente
// de verdad, en vez de repetir la lista de tipos en dos lugares
export const ATTENTION_GEOFENCE_TYPES: ReadonlySet<GeofenceType> = new Set(
  Object.keys(AREA_SEVERITY) as GeofenceType[],
);

// nombre corto en español de cada tipo, para el aviso "Entrando a X (tipo)" - solo se usa para las
// informativas en la practica (las de atencion ya tienen su propio texto completo en
// AREA_ALERT_TEXT), pero se define para los 9 tipos por si algo mas lo necesita a futuro
export const GEOFENCE_TYPE_LABEL: Record<GeofenceType, string> = {
  danger: 'Peligro',
  forbidden: 'Zona prohibida',
  warning: 'Advertencia',
  parking: 'Estacionamiento',
  authorized_route: 'Ruta autorizada',
  allowed: 'Zona permitida',
  discharge: 'Descarga',
  maintenance: 'Mantenimiento',
  carga: 'Carga',
};

const SEVERITY_RANK: Record<'warning' | 'danger', number> = {
  warning: 2,
  danger: 3,
};

export interface OfflineGeofenceMatch {
  geofenceId: number;
  geofenceName: string;
  geofenceType: GeofenceType;
  severity: 'warning' | 'danger';
  message: string;
}

// haversine propio en vez de importarlo de map-core a proposito: este archivo es codigo de
// seguridad que debe correr sin conexion y sin arrastrar el motor de mapas entero (map-core depende
// del DOM). Misma formula y mismo radio terrestre que web/packages/map-core/src/geometry.ts y
// backend/src/utils/geometry.ts - mismo criterio de duplicacion deliberada del resto del proyecto.
const EARTH_RADIUS_M = 6371000;

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// proyeccion plana local: a la escala de una geocerca (metros a pocos km) el error es despreciable
// y permite resolver distancia punto-segmento con algebra simple en vez de trigonometria esferica
function localMeters(lat: number, lon: number, refLat: number): { x: number; y: number } {
  const rad = Math.PI / 180;
  return {
    x: lon * rad * EARTH_RADIUS_M * Math.cos(refLat * rad),
    y: lat * rad * EARTH_RADIUS_M,
  };
}

// silueta real del vehiculo (largo x ancho, rotado por rumbo) - mismo criterio y misma formula
// esferica que backend/src/utils/vehicleFootprint.ts (destinationPoint), duplicado aqui a proposito
// por el mismo motivo que el resto de este archivo: la tableta evalua sola, sin depender del
// backend ni siquiera para construir esta geometria. `headingDeg` debe ser un rumbo YA de confianza
// (ver MIN_SPEED_KMH_FOR_HEADING_TRUST en useLocalAlerts.ts) - construir el rectangulo con un rumbo
// ruidoso lo orientaria mal y podria hacer que un borde real no se detecte
export interface FootprintInput {
  headingDeg: number;
  lengthMeters: number;
  widthMeters: number;
}

function destinationPoint(
  lat: number,
  lon: number,
  bearingDeg: number,
  distanceMeters: number,
): { lat: number; lon: number } {
  const rad = Math.PI / 180;
  const delta = distanceMeters / EARTH_RADIUS_M;
  const theta = bearingDeg * rad;
  const phi1 = lat * rad;
  const lambda1 = lon * rad;
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta),
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );
  return { lat: phi2 / rad, lon: lambda2 / rad };
}

// anillo cerrado (5 puntos, el primero repetido) del rectangulo real del vehiculo, centrado en
// lat/lon y orientado por headingDeg
function buildFootprintRing(lat: number, lon: number, footprint: FootprintInput): { lat: number; lon: number }[] {
  const halfLength = footprint.lengthMeters / 2;
  const halfWidth = footprint.widthMeters / 2;
  const front = destinationPoint(lat, lon, footprint.headingDeg, halfLength);
  const rear = destinationPoint(lat, lon, (footprint.headingDeg + 180) % 360, halfLength);
  const leftBearing = (footprint.headingDeg - 90 + 360) % 360;
  const rightBearing = (footprint.headingDeg + 90) % 360;
  const frontLeft = destinationPoint(front.lat, front.lon, leftBearing, halfWidth);
  const frontRight = destinationPoint(front.lat, front.lon, rightBearing, halfWidth);
  const rearRight = destinationPoint(rear.lat, rear.lon, rightBearing, halfWidth);
  const rearLeft = destinationPoint(rear.lat, rear.lon, leftBearing, halfWidth);
  return [frontLeft, frontRight, rearRight, rearLeft, frontLeft];
}

function distanceToSegmentMeters(
  lat: number, lon: number,
  aLat: number, aLon: number,
  bLat: number, bLon: number,
): number {
  const p = localMeters(lat, lon, lat);
  const a = localMeters(aLat, aLon, lat);
  const b = localMeters(bLat, bLon, lat);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// [lon, lat] es el orden de GeoJSON, no al reves
function distanceToPathMeters(lat: number, lon: number, path: number[][]): number {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const d = distanceToSegmentMeters(lat, lon, path[i][1], path[i][0], path[i + 1][1], path[i + 1][0]);
    if (d < best) best = d;
  }
  return best;
}

// ray casting sobre el anillo exterior, con los agujeros restando (mismo criterio que ST_Contains)
export function pointInPolygon(lat: number, lon: number, rings: number[][][]): boolean {
  if (rings.length === 0) return false;
  if (!ringContains(lat, lon, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (ringContains(lat, lon, rings[i])) return false;
  }
  return true;
}

function ringContains(lat: number, lon: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// interseccion clasica de 2 segmentos por orientacion (productos cruzados) - en metros locales, no
// en grados, para no mezclar escalas de x/y muy distintas a latitudes altas. No maneja el caso
// colineal exacto (dos bordes superpuestos en la misma linea) - caso degenerado, no relevante para
// un borde real de geocerca contra el borde de un rectangulo de vehiculo
function segmentsIntersect(
  a1: { x: number; y: number }, a2: { x: number; y: number },
  b1: { x: number; y: number }, b2: { x: number; y: number },
): boolean {
  const cross = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(b1, b2, a1);
  const d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1);
  const d4 = cross(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

// true = el rectangulo real del vehiculo toca/se traslapa con un poligono arbitrario (posiblemente
// no convexo, con agujeros) - 3 pruebas, cualquiera basta: (1) algun vertice del footprint cae
// dentro del poligono, (2) algun vertice del poligono (exterior o agujero) cae dentro del footprint,
// (3) algun borde del footprint cruza algun borde del poligono (cubre bordes que se cruzan sin que
// ningun vertice de ninguno de los dos quede dentro del otro). No es SAT (el poligono real no tiene
// por que ser convexo, a diferencia del footprint-contra-footprint de CollisionRiskService) pero
// para un rectangulo pequeño de vehiculo contra un poligono dibujado a mano es suficientemente
// robusto en la practica.
function footprintTouchesRings(footprintRing: { lat: number; lon: number }[], rings: number[][][]): boolean {
  for (const p of footprintRing) {
    if (pointInPolygon(p.lat, p.lon, rings)) return true;
  }
  const footprintAsRing = footprintRing.map((p) => [p.lon, p.lat]);
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (ringContains(lat, lon, footprintAsRing)) return true;
    }
  }
  const refLat = footprintRing[0].lat;
  const footprintLocal = footprintRing.map((p) => localMeters(p.lat, p.lon, refLat));
  for (let i = 0; i < footprintLocal.length - 1; i++) {
    for (const ring of rings) {
      for (let j = 0; j < ring.length - 1; j++) {
        const b1 = localMeters(ring[j][1], ring[j][0], refLat);
        const b2 = localMeters(ring[j + 1][1], ring[j + 1][0], refLat);
        if (segmentsIntersect(footprintLocal[i], footprintLocal[i + 1], b1, b2)) return true;
      }
    }
  }
  return false;
}

// true = el rectangulo real del vehiculo toca/se traslapa con un circulo (centro + radio)
function footprintTouchesCircle(
  footprintRing: { lat: number; lon: number }[],
  centerLat: number,
  centerLon: number,
  radiusMeters: number,
): boolean {
  const footprintAsRing = footprintRing.map((p) => [p.lon, p.lat]);
  if (ringContains(centerLat, centerLon, footprintAsRing)) return true;
  for (let i = 0; i < footprintRing.length - 1; i++) {
    const d = distanceToSegmentMeters(
      centerLat, centerLon,
      footprintRing[i].lat, footprintRing[i].lon,
      footprintRing[i + 1].lat, footprintRing[i + 1].lon,
    );
    if (d <= radiusMeters) return true;
  }
  return false;
}

// distancia minima de cualquier vertice del footprint a un camino (linea/borde de poligono) - no es
// la distancia borde-a-borde exacta, pero para un rectangulo pequeño de vehiculo contra un camino
// relativamente recto a esta escala local, los vertices ya dominan el resultado
function footprintMinDistanceToPath(footprintRing: { lat: number; lon: number }[], path: number[][]): number {
  let best = Infinity;
  for (const p of footprintRing) {
    const d = distanceToPathMeters(p.lat, p.lon, path);
    if (d < best) best = d;
  }
  return best;
}

// true = la posicion dispara esta geocerca. Espeja las 5 ramas del WHERE de findMatchingSpatial:
// circulo por radio, poligono con relleno por contencion, poligono sin relleno por cercania al
// borde, linea "debe quedarse dentro" por salir del ancho, linea "no tocar" por entrar en el ancho.
//
// `footprint` (silueta real del vehiculo, ya orientada por un rumbo de confianza) y `bufferMeters`
// (radio de incertidumbre del GPS, para el aviso temprano - ver evaluateGeofencesNearby) son
// mutuamente excluyentes a proposito: con footprint se prueba el rectangulo real (el caso "de
// verdad tocando"), sin footprint se prueba el punto ensanchado por bufferMeters (el caso
// "podria estar tocando, dado el margen de error del GPS") - nunca los dos juntos, serian dos
// nociones de holgura combinadas sin necesidad real.
function isTriggered(
  lat: number,
  lon: number,
  geofence: Geofence,
  footprint?: FootprintInput | null,
  bufferMeters = 0,
): boolean {
  const footprintRing = footprint ? buildFootprintRing(lat, lon, footprint) : null;

  if (geofence.shapeType === 'circle') {
    if (footprintRing) {
      return footprintTouchesCircle(footprintRing, geofence.center.lat, geofence.center.lon, geofence.radiusMeters);
    }
    return haversineMeters(lat, lon, geofence.center.lat, geofence.center.lon) <= geofence.radiusMeters + bufferMeters;
  }

  if (geofence.shapeType === 'polygon') {
    const rings = geofence.geometry.coordinates;
    if (geofence.filled !== false) {
      if (footprintRing) return footprintTouchesRings(footprintRing, rings);
      if (pointInPolygon(lat, lon, rings)) return true;
      return bufferMeters > 0 && rings.some((ring) => distanceToPathMeters(lat, lon, ring) <= bufferMeters);
    }
    const width = geofence.corridorWidthMeters ?? 0;
    if (footprintRing) return rings.some((ring) => footprintMinDistanceToPath(footprintRing, ring) <= width);
    return rings.some((ring) => distanceToPathMeters(lat, lon, ring) <= width + bufferMeters);
  }

  // 'authorized_route' nunca alerta (ver AREA_SEVERITY del backend) - no llega hasta aqui porque
  // se filtra antes por no tener severidad, pero el mecanismo generico de linea vale para el resto
  const width = geofence.corridorWidthMeters;
  if (footprintRing) {
    const distance = footprintMinDistanceToPath(footprintRing, geofence.geometry.coordinates);
    return geofence.stayInside !== false ? distance > width : distance <= width;
  }
  const distance = distanceToPathMeters(lat, lon, geofence.geometry.coordinates);
  return geofence.stayInside !== false ? distance > width - bufferMeters : distance <= width + bufferMeters;
}

// se queda con la de mayor severidad, igual que el backend con maxSeverity - null si ninguna aplica.
// `footprint` (silueta real del vehiculo, opcional) reemplaza la prueba de punto crudo por el
// rectangulo real orientado - bug real reportado en campo con captura: una geocerca "zona
// prohibida" no avisaba hasta que el CENTRO exacto del vehiculo (un punto sin dimension) entraba al
// poligono, aunque la silueta real ya estuviera tocando el borde. Sin `footprint` (dispositivo sin
// tipo de vehiculo asignado, o sin rumbo de confianza todavia) cae al punto crudo de siempre - cero
// regresion para esos casos.
export function evaluateGeofencesOffline(
  lat: number,
  lon: number,
  geofences: Geofence[],
  footprint?: FootprintInput | null,
): OfflineGeofenceMatch | null {
  let best: OfflineGeofenceMatch | null = null;

  for (const geofence of geofences) {
    const severity = AREA_SEVERITY[geofence.type];
    if (!severity) continue; // allowed/discharge/carga/authorized_route/parking/maintenance: informativas, nunca alertan
    if (!isTriggered(lat, lon, geofence, footprint)) continue;
    if (best && SEVERITY_RANK[best.severity] >= SEVERITY_RANK[severity]) continue;

    best = {
      geofenceId: geofence.id,
      geofenceName: geofence.name,
      geofenceType: geofence.type,
      severity,
      message: AREA_ALERT_TEXT[geofence.type] ?? 'ZONA DE RIESGO',
    };
  }

  return best;
}

// aviso TEMPRANO, solo para circulo y poligono relleno (los 2 casos donde "tocar el circulo de
// incertidumbre del GPS" tiene sentido operativo real - pedido explicito con captura: "el radio de
// precision... al tocar aunque sea un borde... debe notificar" con severidad menor que el toque
// real). Nunca reemplaza a evaluateGeofencesOffline - se llama aparte y solo importa cuando esa
// devuelve null para la MISMA geocerca (si el footprint/punto real ya la toca, esa ya gano con su
// severidad real, no hace falta el aviso de "acercandose"). Nunca se reporta al servidor como
// transicion (no es una entrada/salida real, solo un heads-up local) - ver useLocalAlerts.ts.
export function evaluateGeofencesNearby(
  lat: number,
  lon: number,
  geofences: Geofence[],
  accuracyMeters: number,
  footprint?: FootprintInput | null,
): OfflineGeofenceMatch | null {
  if (!(accuracyMeters > 0)) return null;

  for (const geofence of geofences) {
    if (geofence.shapeType !== 'circle' && !(geofence.shapeType === 'polygon' && geofence.filled !== false)) {
      continue;
    }
    const severity = AREA_SEVERITY[geofence.type];
    if (!severity) continue;
    if (isTriggered(lat, lon, geofence, footprint)) continue; // ya toca de verdad - esa gana, sin aviso temprano
    if (!isTriggered(lat, lon, geofence, null, accuracyMeters)) continue;

    return {
      geofenceId: geofence.id,
      geofenceName: geofence.name,
      geofenceType: geofence.type,
      severity: 'warning',
      message: NEAR_ALERT_TEXT[geofence.type] ?? 'PRECAUCIÓN - ACERCÁNDOSE A ZONA DE RIESGO',
    };
  }

  return null;
}

// "zona permitida" (allowed) es el limite operativo real (ej. contorno de la mina) - sin severidad
// propia, asi que no pasa por evaluateGeofencesOffline. Se pregunta aparte, solo para dispositivos
// restringidos (ver useLocalAlerts.ts) - mismo isTriggered que el resto, misma semantica que el
// servidor (GeofenceAlertService.evaluate(), matches.find(g => g.type === 'allowed')).
export function isInsideAllowedZone(lat: number, lon: number, geofences: Geofence[]): boolean {
  return geofences.some((g) => g.type === 'allowed' && isTriggered(lat, lon, g));
}

// para el aviso "Entrando a/Saliendo de zona X" (toast, sin sonido - ver useLocalAlerts.ts) -
// TODAS las geocercas informativas activas a la vez, no solo la mas severa (no tienen severidad
// que comparar): puede haber varias encimadas o contiguas (ej. un estacionamiento dentro de una
// ruta autorizada) y el operador debe ver el transito de las dos, no solo una.
export function matchedInformativeGeofences(lat: number, lon: number, geofences: Geofence[]): Geofence[] {
  return geofences.filter((g) => !ATTENTION_GEOFENCE_TYPES.has(g.type) && isTriggered(lat, lon, g));
}
