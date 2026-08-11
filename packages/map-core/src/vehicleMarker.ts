/**
 * vehicleMarker.ts
 *
 * ÚNICA implementación del marcador de vehículo sobre MapLibre —
 * antes duplicada casi igual en Operador y Supervisor (círculo con
 * borde de color + etiqueta, sin indicar dirección). Agrega una
 * flecha de rumbo (a partir de `course`, que ya viaja en `Position`
 * pero no se usaba en el mapa) y estados visuales de "detenido" /
 * "posición vieja" / "amenaza cercana" reutilizables entre apps.
 *
 * Las animaciones (pulso de `--threat`) se definen en el CSS de cada
 * app (operator.css/supervisor.css) sobre la clase que este módulo
 * asigna — aquí solo se resuelve estructura DOM + estilos inline
 * base, igual que el resto de map-core.
 */

/** Por debajo de esta velocidad el `course` del GPS es ruido, no rumbo real. */
const MIN_MOVING_SPEED_MPS = 0.5;

const MARKER_SIZE = 40;

/** Último rumbo válido conocido por dispositivo — persiste mientras el vehículo está detenido. */
const lastKnownCourse = new Map<string, number>();

export interface VehicleMarkerOptions {
  deviceId: string;
  isMine: boolean;
  color: string;
}

/**
 * Resuelve qué rumbo mostrar: el actual si el vehículo se está
 * moviendo, o el último conocido (marcado como "stopped") si no.
 */
export function resolveVehicleCourse(
  deviceId: string,
  course: number | undefined,
  speed: number | undefined,
): { course: number; stopped: boolean } {
  const isMoving = (speed ?? 0) > MIN_MOVING_SPEED_MPS;

  if (isMoving && course !== undefined) {
    lastKnownCourse.set(deviceId, course);
    return { course, stopped: false };
  }

  const remembered = lastKnownCourse.get(deviceId);
  return { course: remembered ?? course ?? 0, stopped: true };
}

/**
 * Overlay rotable del mismo tamaño que su contenedor — al rotarlo,
 * su centro por defecto (50%/50%) coincide con el centro del
 * marcador, así que la flecha (dibujada apuntando "afuera" del
 * overlay) barre alrededor sin cálculos manuales de transform-origin.
 * El contenedor donde se inserta debe tener `position: relative` y
 * tamaño fijo — lo tienen tanto `createVehicleMarkerElement` como el
 * `.sup-vehicle-marker` de Supervisor.
 */
export function createHeadingArrow(color: string): HTMLDivElement {
  const arrow = document.createElement('div');
  arrow.className = 'vehicle-marker__arrow';
  arrow.style.position = 'absolute';
  arrow.style.inset = '0';
  arrow.style.display = 'flex';
  arrow.style.justifyContent = 'center';
  arrow.style.pointerEvents = 'none';
  arrow.style.transition = 'opacity 0.3s ease';

  const chevron = document.createElement('div');
  chevron.style.width = '0';
  chevron.style.height = '0';
  chevron.style.marginTop = '-9px';
  chevron.style.borderLeft = '6px solid transparent';
  chevron.style.borderRight = '6px solid transparent';
  chevron.style.borderBottom = `9px solid ${color}`;
  arrow.appendChild(chevron);

  return arrow;
}

/** Crea el elemento DOM del marcador — círculo + etiqueta + flecha de rumbo. Usado por Operador. */
export function createVehicleMarkerElement({ deviceId, isMine, color }: VehicleMarkerOptions): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'vehicle-marker';
  el.style.position = 'relative';
  el.style.width = `${MARKER_SIZE}px`;
  el.style.height = `${MARKER_SIZE}px`;
  el.style.borderRadius = '50%';
  el.style.border = `3px solid ${color}`;
  el.style.background = isMine ? '#003322' : '#330a00';
  el.style.color = color;
  el.style.fontSize = '10px';
  el.style.fontWeight = 'bold';
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';
  el.style.cursor = 'pointer';
  el.style.boxShadow = `0 0 8px ${color}`;
  el.textContent = isMine ? 'YO' : `V${deviceId}`;

  el.appendChild(createHeadingArrow(color));
  return el;
}

/**
 * Actualiza la rotación de la flecha según el rumbo/velocidad más
 * reciente. Recibe `HTMLElement` (no `HTMLDivElement`) a propósito —
 * es el tipo que devuelve `maplibregl.Marker.getElement()`.
 */
export function updateVehicleMarkerHeading(
  el: HTMLElement,
  deviceId: string,
  course: number | undefined,
  speed: number | undefined,
): void {
  const arrow = el.querySelector<HTMLDivElement>('.vehicle-marker__arrow');
  if (!arrow) return;

  const { course: resolvedCourse, stopped } = resolveVehicleCourse(deviceId, course, speed);
  arrow.style.transform = `rotate(${resolvedCourse}deg)`;
  // Detenido: el rumbo mostrado puede estar viejo — se atenúa en vez
  // de ocultarse, para no perder la información por completo.
  arrow.style.opacity = stopped ? '0.4' : '1';
}

/** Marca/desmarca el marcador como "amenaza" (vehículo más cercano durante una alerta activa). */
export function setVehicleMarkerThreat(el: HTMLElement, isThreat: boolean): void {
  el.classList.toggle('vehicle-marker--threat', isThreat);
}

/** Marca/desmarca el marcador como "posición vieja" (sin actualizar por más del umbral de señal perdida). */
export function setVehicleMarkerStale(el: HTMLElement, isStale: boolean): void {
  el.classList.toggle('vehicle-marker--stale', isStale);
  el.style.opacity = isStale ? '0.4' : '1';
}
