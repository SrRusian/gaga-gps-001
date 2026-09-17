// auto-calibracion del desfase de montaje de la tablet (soporte chueco/girado en la cabina) -
// pedido explicito: si la brujula del propio tablet (useDeviceOrientation.ts, respaldo del rumbo
// GPS solo mientras el vehiculo esta detenido) no coincide con hacia donde realmente apunta el
// vehiculo, el mapa "brinca" al frenar. Mientras el vehiculo se mueve de verdad, el rumbo GPS es
// confiable - la diferencia entre GPS y brujula en ese momento ES el angulo al que esta girado el
// soporte, y se puede aprender solo, sin pedirle nada al operador.

// mismo umbral de "rumbo GPS confiable" que ya usa el backend para orientar el rectangulo del
// vehiculo (ver backend/src/utils/vehicleFootprint.ts, COURSE_TRUST_MIN_KMH) - no es codigo
// compartido (cliente vs servidor, distintos archivos a proposito, mismo criterio del proyecto que
// PositionFilterService), pero conviene el mismo numero para que "confiable" signifique lo mismo
// en los dos lugares.
const MIN_SPEED_MPS_FOR_CALIBRATION = 0.83; // ~3 km/h
// zona muerta - ignora la vibracion normal de cabina (motor, baches) para que el offset aprendido
// no tiemble con cada lectura
const DEADBAND_DEGREES = 3.5;
// EMA - que tan rapido se asimila un cambio real (alguien giro el soporte a mano) una vez que supera
// la zona muerta. 0.15 = calibra en unos segundos de tramo recto sin saltar de golpe
const SMOOTHING_FACTOR = 0.15;

export interface HeadingOffsetState {
  // null = todavia no se aprendio ningun desfase (recien arranco, o nunca hubo un tramo confiable)
  offsetDeg: number | null;
}

export const INITIAL_HEADING_OFFSET_STATE: HeadingOffsetState = { offsetDeg: null };

// diferencia angular mas corta entre dos angulos, en (-180, 180] - maneja el cruce 359->0
function angleDiff(a: number, b: number): number {
  let diff = a - b;
  while (diff <= -180) diff += 360;
  while (diff > 180) diff -= 360;
  return diff;
}

// aprende (o refina) el desfase mientras el vehiculo va a velocidad confiable - no hace nada si va
// lento/detenido (ahi el GPS ya no es una referencia confiable para comparar)
export function updateHeadingOffset(
  state: HeadingOffsetState,
  gpsCourseDeg: number,
  compassHeadingDeg: number,
  speedMps: number,
): HeadingOffsetState {
  if (speedMps < MIN_SPEED_MPS_FOR_CALIBRATION) return state;

  const instantOffset = angleDiff(gpsCourseDeg, compassHeadingDeg);

  if (state.offsetDeg === null) {
    return { offsetDeg: instantOffset };
  }

  const delta = angleDiff(instantOffset, state.offsetDeg);
  if (Math.abs(delta) <= DEADBAND_DEGREES) return state;

  return { offsetDeg: angleDiff(state.offsetDeg + delta * SMOOTHING_FACTOR, 0) };
}

// aplica el desfase aprendido a una lectura de brujula - usar solo mientras el vehiculo esta
// detenido (con movimiento real, el rumbo GPS ya es la fuente, sin pasar por aqui)
export function applyHeadingOffset(compassHeadingDeg: number, offsetDeg: number | null): number {
  if (offsetDeg === null) return compassHeadingDeg;
  return (compassHeadingDeg + offsetDeg + 360) % 360;
}
