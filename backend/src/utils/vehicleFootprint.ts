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
