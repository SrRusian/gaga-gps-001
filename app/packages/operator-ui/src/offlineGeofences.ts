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

const AREA_SEVERITY: Partial<Record<GeofenceType, 'warning' | 'danger' | 'info'>> = {
  danger: 'danger',
  forbidden: 'danger',
  warning: 'warning',
  maintenance: 'warning',
  parking: 'info',
};

const AREA_ALERT_TEXT: Partial<Record<GeofenceType, string>> = {
  danger: 'PELIGRO - DETENER VEHÍCULO INMEDIATAMENTE',
  forbidden: 'ZONA PROHIBIDA - NO INGRESAR - DETENER VEHÍCULO',
  warning: 'PRECAUCIÓN - ZONA DE RIESGO - REDUCIR VELOCIDAD',
  maintenance: 'ZONA EN MANTENIMIENTO - PRECAUCIÓN',
  parking: 'ZONA DE ESTACIONAMIENTO',
};

const SEVERITY_RANK: Record<'info' | 'warning' | 'danger', number> = {
  info: 1,
  warning: 2,
  danger: 3,
};

export interface OfflineGeofenceMatch {
  geofenceId: number;
  geofenceName: string;
  geofenceType: GeofenceType;
  severity: 'warning' | 'danger' | 'info';
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

// true = la posicion dispara esta geocerca. Espeja las 5 ramas del WHERE de findMatchingSpatial:
// circulo por radio, poligono con relleno por contencion, poligono sin relleno por cercania al
// borde, linea "debe quedarse dentro" por salir del ancho, linea "no tocar" por entrar en el ancho.
function isTriggered(lat: number, lon: number, geofence: Geofence): boolean {
  if (geofence.shapeType === 'circle') {
    return haversineMeters(lat, lon, geofence.center.lat, geofence.center.lon) <= geofence.radiusMeters;
  }

  if (geofence.shapeType === 'polygon') {
    const rings = geofence.geometry.coordinates;
    if (geofence.filled !== false) return pointInPolygon(lat, lon, rings);
    const width = geofence.corridorWidthMeters ?? 0;
    return rings.some((ring) => distanceToPathMeters(lat, lon, ring) <= width);
  }

  // 'authorized_route' nunca alerta (ver AREA_SEVERITY del backend) - no llega hasta aqui porque
  // se filtra antes por no tener severidad, pero el mecanismo generico de linea vale para el resto
  const distance = distanceToPathMeters(lat, lon, geofence.geometry.coordinates);
  return geofence.stayInside !== false
    ? distance > geofence.corridorWidthMeters
    : distance <= geofence.corridorWidthMeters;
}

// se queda con la de mayor severidad, igual que el backend con maxSeverity - null si ninguna aplica
export function evaluateGeofencesOffline(
  lat: number,
  lon: number,
  geofences: Geofence[],
): OfflineGeofenceMatch | null {
  let best: OfflineGeofenceMatch | null = null;

  for (const geofence of geofences) {
    const severity = AREA_SEVERITY[geofence.type];
    if (!severity) continue; // allowed/discharge/carga/authorized_route: nunca alertan
    if (!isTriggered(lat, lon, geofence)) continue;
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

// "zona permitida" (allowed) es el limite operativo real (ej. contorno de la mina) - sin severidad
// propia, asi que no pasa por evaluateGeofencesOffline. Se pregunta aparte, solo para dispositivos
// restringidos (ver useLocalAlerts.ts) - mismo isTriggered que el resto, misma semantica que el
// servidor (GeofenceAlertService.evaluate(), matches.find(g => g.type === 'allowed')).
export function isInsideAllowedZone(lat: number, lon: number, geofences: Geofence[]): boolean {
  return geofences.some((g) => g.type === 'allowed' && isTriggered(lat, lon, g));
}
