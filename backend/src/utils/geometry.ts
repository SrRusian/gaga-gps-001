import type { CorridorSeverity, Geofence, PolygonGeofence } from '@gaga-gps/shared-types';
import type { LineString, Polygon } from 'geojson';

const EARTH_RADIUS_METERS = 6371000;

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

export function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

export function isPointInPolygon(lat: number, lon: number, polygonGeometry: Polygon): boolean {
  const ring = polygonGeometry.coordinates[0];
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; // GeoJSON es [lon, lat]
    const [xj, yj] = ring[j];

    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;

    if (intersects) inside = !inside;
  }

  return inside;
}

export function distancePointToSegmentMeters(
  lat: number,
  lon: number,
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const latRef = toRad((lat1 + lat2) / 2);
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos(latRef);

  const toXY = (pLat: number, pLon: number): [number, number] => [
    (pLon - lon1) * metersPerDegLon,
    (pLat - lat1) * metersPerDegLat,
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

export function distancePointToLineMeters(
  lat: number,
  lon: number,
  lineGeometry: LineString,
): number {
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

export function isInsideGeofence(lat: number, lon: number, geofence: Geofence): boolean {
  switch (geofence.shapeType) {
    case 'polygon':
      return isPointInPolygon(lat, lon, (geofence as PolygonGeofence).geometry);

    case 'polyline':
      return distancePointToLineMeters(lat, lon, geofence.geometry) <= geofence.corridorWidthMeters;

    case 'circle':
    default:
      return (
        haversineDistance(lat, lon, geofence.center.lat, geofence.center.lon) <=
        geofence.radiusMeters
      );
  }
}

export function getCorridorSeverity(
  lat: number,
  lon: number,
  geofence: {
    geometry: LineString;
    corridorWidthMeters: number;
    corridorDangerMarginMeters?: number;
  },
): CorridorSeverity {
  const distance = distancePointToLineMeters(lat, lon, geofence.geometry);

  if (distance <= geofence.corridorWidthMeters) return null;

  const dangerMargin = geofence.corridorDangerMarginMeters;
  if (dangerMargin && distance > geofence.corridorWidthMeters + dangerMargin) {
    return 'danger';
  }
  return 'warning';
}
