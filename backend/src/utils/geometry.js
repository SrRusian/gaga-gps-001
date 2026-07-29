/**
 * geometry.js
 *
 * Utilidades de geometría reutilizables para evaluar geocercas de
 * cualquier forma (círculo, polígono, ruta/corredor) y para cruzar
 * el historial de posiciones contra zonas autorizadas.
 *
 * No depende de PostGIS — todo se calcula en JavaScript sobre
 * coordenadas WGS84 decimal, consistente con el resto del sistema.
 */

const EARTH_RADIUS_METERS = 6371000;

function toRad(deg) {
  return deg * (Math.PI / 180);
}

/**
 * Distancia en metros entre dos coordenadas — fórmula de Haversine.
 * (Idéntica a la ya usada en GeofenceAlertService/CollisionRiskService/
 * StaticEquipmentManager — centralizada aquí para nuevas funciones
 * que la necesitan, sin duplicar código).
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * Determina si un punto (lat, lon) está dentro de un polígono
 * GeoJSON — algoritmo ray casting sobre el anillo exterior.
 * No soporta huecos (anillos interiores) — no se requieren para
 * geocercas de zona autorizada.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {Object} polygonGeometry - GeoJSON { type: 'Polygon', coordinates: [[[lon,lat],...]] }
 * @returns {boolean}
 */
function isPointInPolygon(lat, lon, polygonGeometry) {
  const ring = polygonGeometry.coordinates[0];
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; // GeoJSON es [lon, lat]
    const [xj, yj] = ring[j];

    const intersects =
      (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;

    if (intersects) inside = !inside;
  }

  return inside;
}

/**
 * Distancia mínima en metros de un punto a un segmento de línea
 * (aproximación planar válida para distancias cortas — cientos de
 * metros a pocos kilómetros — típicas de un sitio minero).
 */
function distancePointToSegmentMeters(lat, lon, lat1, lon1, lat2, lon2) {
  // Proyección equirectangular local para trabajar en metros,
  // con el primer punto del segmento como origen (0, 0)
  const latRef = toRad((lat1 + lat2) / 2);
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos(latRef);

  const toXY = (pLat, pLon) => [
    (pLon - lon1) * metersPerDegLon,
    (pLat - lat1) * metersPerDegLat
  ];

  const [px, py] = toXY(lat, lon);
  const [qx, qy] = toXY(lat2, lon2);

  const segLenSq = qx * qx + qy * qy;
  if (segLenSq === 0) {
    return haversineDistance(lat, lon, lat1, lon1);
  }

  let t = (px * qx + py * qy) / segLenSq;
  t = Math.max(0, Math.min(1, t));

  const closestX = t * qx;
  const closestY = t * qy;

  return Math.sqrt((px - closestX) ** 2 + (py - closestY) ** 2);
}

/**
 * Distancia mínima en metros de un punto a una polilínea GeoJSON
 * completa (evalúa todos los segmentos consecutivos).
 *
 * @param {Object} lineGeometry - GeoJSON { type: 'LineString', coordinates: [[lon,lat],...] }
 */
function distancePointToLineMeters(lat, lon, lineGeometry) {
  const coords = lineGeometry.coordinates;
  let minDistance = Infinity;

  for (let i = 0; i < coords.length - 1; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[i + 1];
    const d = distancePointToSegmentMeters(lat, lon, lat1, lon1, lat2, lon2);
    if (d < minDistance) minDistance = d;
  }

  return minDistance;
}

/**
 * Evalúa si una posición está dentro de una geocerca, sin importar
 * su forma — punto único de verdad usado tanto por
 * GeofenceAlertService (tiempo real) como por el cruce de
 * historial contra zonas (route-zone-crossref).
 *
 * @param {number} lat
 * @param {number} lon
 * @param {Object} geofence - fila normalizada { shapeType, center, radiusMeters, geometry, corridorWidthMeters }
 * @returns {boolean}
 */
function isInsideGeofence(lat, lon, geofence) {
  switch (geofence.shapeType) {
    case 'polygon':
      return isPointInPolygon(lat, lon, geofence.geometry);

    case 'polyline':
      return distancePointToLineMeters(lat, lon, geofence.geometry) <= geofence.corridorWidthMeters;

    case 'circle':
    default:
      return haversineDistance(lat, lon, geofence.center.lat, geofence.center.lon) <= geofence.radiusMeters;
  }
}

module.exports = {
  haversineDistance,
  isPointInPolygon,
  distancePointToSegmentMeters,
  distancePointToLineMeters,
  isInsideGeofence
};
