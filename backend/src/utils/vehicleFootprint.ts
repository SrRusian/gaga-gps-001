// mismo radio terrestre que haversineMeters en web/packages/map-core/src/geometry.ts (consistencia)
const EARTH_RADIUS_M = 6371000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

// formula esferica estandar "punto destino dado rumbo+distancia" - se calcula en TS (no en PostGIS
// con ST_Project encadenado) para poder probarla con tests unitarios reales, no una cadena de
// trigonometria dentro de SQL sin forma facil de verificar a mano.
export function destinationPoint(
  lat: number,
  lon: number,
  bearingDeg: number,
  distanceMeters: number,
): { lat: number; lon: number } {
  const delta = distanceMeters / EARTH_RADIUS_M;
  const theta = toRad(bearingDeg);
  const phi1 = toRad(lat);
  const lambda1 = toRad(lon);

  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta),
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );

  return { lat: toDeg(phi2), lon: toDeg(lambda2) };
}

// rectangulo orientado real del vehiculo (largo x ancho, metros) centrado en lat/lon y rotado segun
// el rumbo - devuelve WKT listo para ST_GeogFromText(). Anillo cerrado (5 puntos, el primero
// repetido al final, requisito de WKT POLYGON).
export function buildVehicleFootprintWkt(
  lat: number,
  lon: number,
  headingDeg: number,
  lengthMeters: number,
  widthMeters: number,
): string {
  const halfLength = lengthMeters / 2;
  const halfWidth = widthMeters / 2;

  const front = destinationPoint(lat, lon, headingDeg, halfLength);
  const rear = destinationPoint(lat, lon, (headingDeg + 180) % 360, halfLength);

  const leftBearing = (headingDeg - 90 + 360) % 360;
  const rightBearing = (headingDeg + 90) % 360;

  const frontLeft = destinationPoint(front.lat, front.lon, leftBearing, halfWidth);
  const frontRight = destinationPoint(front.lat, front.lon, rightBearing, halfWidth);
  const rearRight = destinationPoint(rear.lat, rear.lon, rightBearing, halfWidth);
  const rearLeft = destinationPoint(rear.lat, rear.lon, leftBearing, halfWidth);

  const ring = [frontLeft, frontRight, rearRight, rearLeft, frontLeft];
  const points = ring.map((p) => `${p.lon} ${p.lat}`).join(', ');
  return `POLYGON((${points}))`;
}

// parsea el WKT que produce buildVehicleFootprintWkt de vuelta a puntos [lon,lat] - control total
// del formato de salida (siempre "POLYGON((lon lat, lon lat, ...))"), asi que un parseo simple por
// texto es seguro, sin necesitar una libreria WKT completa
export function parseFootprintWkt(wkt: string): [number, number][] {
  const inner = wkt.slice(wkt.indexOf('((') + 2, wkt.lastIndexOf('))'));
  return inner.split(',').map((pair) => {
    const [lon, lat] = pair.trim().split(/\s+/).map(Number);
    return [lon, lat];
  });
}

// mismo valor ya usado en varios lugares del frontend (vehicleMarker.ts, MapView.tsx) - metros por
// grado de latitud (aprox, valido a las escalas de este proyecto)
const METERS_PER_DEG_LAT = 111320;

// aplana lon/lat a metros locales (equirectangular, valido para distancias de pocos metros a unos
// cientos de metros) alrededor de un punto de referencia compartido - necesario antes de correr SAT,
// ST_Intersects requeriria una consulta a Postgres por par evaluado y esto corre por cada posicion
export function toLocalMeters(
  lon: number,
  lat: number,
  refLon: number,
  refLat: number,
): [number, number] {
  const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180);
  return [(lon - refLon) * metersPerDegLon, (lat - refLat) * METERS_PER_DEG_LAT];
}

function projectPolygon(points: [number, number][], axis: [number, number]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const [x, y] of points) {
    const dot = x * axis[0] + y * axis[1];
    if (dot < min) min = dot;
    if (dot > max) max = dot;
  }
  return [min, max];
}

// SAT (separating axis theorem) para 2 poligonos convexos - un rectangulo real de vehiculo siempre
// es convexo, asi que esto basta (no hace falta una libreria de geometria completa como turf/JSTS)
function polygonsOverlap(a: [number, number][], b: [number, number][]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length - 1; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[i + 1];
      const axis: [number, number] = [-(y2 - y1), x2 - x1];
      const [minA, maxA] = projectPolygon(a, axis);
      const [minB, maxB] = projectPolygon(b, axis);
      if (maxA < minB || maxB < minA) return false; // eje separador encontrado - no se tocan
    }
  }
  return true;
}

// true = las dos siluetas reales del vehiculo (rectangulos orientados) se tocan/traslapan de verdad
// - "choque realizado" para CollisionRiskService, sin importar la direccion/ruta de cada uno
export function footprintsOverlap(wktA: string, wktB: string): boolean {
  const ringA = parseFootprintWkt(wktA);
  const ringB = parseFootprintWkt(wktB);
  const [refLon, refLat] = ringA[0];
  const localA = ringA.map(([lon, lat]) => toLocalMeters(lon, lat, refLon, refLat));
  const localB = ringB.map(([lon, lat]) => toLocalMeters(lon, lat, refLon, refLat));
  return polygonsOverlap(localA, localB);
}

const COURSE_TRUST_MIN_KMH = 3;

// el rumbo GPS es poco confiable a baja velocidad (mismo principio ya documentado para la brujula
// del Operador, useDeviceOrientation.ts) - se congela el ultimo rumbo confiable conocido mientras el
// vehiculo va lento/detenido, en vez de rotar el rectangulo con un rumbo ruidoso. Estado en memoria
// por dispositivo, mismo patron que CollisionRiskService.positionHistory.
export class VehicleHeadingTracker {
  private lastTrustedCourseByDevice: Record<string, number> = {};

  // null si el dispositivo nunca reporto un rumbo confiable todavia (recien arranco, nunca se movio)
  resolveTrustedCourse(deviceId: string, courseDeg: number | undefined, speedKmh: number): number | null {
    if (courseDeg != null && !Number.isNaN(courseDeg) && speedKmh >= COURSE_TRUST_MIN_KMH) {
      this.lastTrustedCourseByDevice[deviceId] = courseDeg;
    }
    return this.lastTrustedCourseByDevice[deviceId] ?? null;
  }

  clearDevice(deviceId: string): void {
    delete this.lastTrustedCourseByDevice[deviceId];
  }
}
