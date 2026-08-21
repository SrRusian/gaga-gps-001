const MIN_MOVING_SPEED_MPS = 0.5;
const ARROW_SIZE = 34;
const RING_SIZE = ARROW_SIZE + 14;
// mismos valores que colors.danger/colors.selected en @gaga-gps/ui - duplicados a propósito,
// este paquete no depende de packages/ui (ver EQUIPMENT_CORE_COLOR/EQUIPMENT_OUTER_COLOR, mismo criterio)
const SELECTED_RING_COLOR = '#ffd23f';
const OFFLINE_COLOR = '#e5484d';
const lastKnownCourse = new Map<string, number>();

export function shortVehicleLabel(deviceId: string): string {
  const digitRuns = deviceId.match(/\d+/g);
  if (digitRuns && digitRuns.length > 0) {
    return digitRuns[digitRuns.length - 1];
  }
  return deviceId.slice(0, 3).toUpperCase();
}

export interface VehicleMarkerOptions {
  deviceId: string;
  isMine: boolean;
  color: string;
}

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

// flecha de rumbo estilo navegación (ícono "navigation" de Material) - grande y perceptible a
// simple vista, a diferencia del chevron chico de antes. 0deg = apunta al norte, coincide con
// como ya se interpreta `course` (grados desde el norte) al aplicarlo directo como rotate(deg).
export function createHeadingArrow(color: string): HTMLDivElement {
  const arrow = document.createElement('div');
  arrow.className = 'vehicle-marker__arrow';
  arrow.style.position = 'absolute';
  arrow.style.top = '50%';
  arrow.style.left = '50%';
  arrow.style.width = `${ARROW_SIZE}px`;
  arrow.style.height = `${ARROW_SIZE}px`;
  arrow.style.marginLeft = `-${ARROW_SIZE / 2}px`;
  arrow.style.marginTop = `-${ARROW_SIZE / 2}px`;
  arrow.style.pointerEvents = 'none';
  arrow.style.transition = 'opacity 0.3s ease';
  arrow.style.filter = `drop-shadow(0 0 4px ${color}) drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6))`;
  arrow.dataset.baseColor = color;
  arrow.innerHTML = `
    <svg viewBox="0 0 24 24" width="${ARROW_SIZE}" height="${ARROW_SIZE}">
      <path d="M12 2L4.5 20.29 5.21 21 12 18 18.79 21 19.5 20.29z"
            fill="${color}" stroke="#0b0d10" stroke-width="1.5" stroke-linejoin="round" />
    </svg>
  `;

  return arrow;
}

// anillo de selección - elemento aparte que NO rota (a diferencia de .vehicle-marker__arrow),
// para que "seleccionado" no dependa/interfiera con el color de identidad (mío/otro/desconectado)
function createSelectionRing(): HTMLDivElement {
  const ring = document.createElement('div');
  ring.className = 'vehicle-marker__ring';
  ring.style.position = 'absolute';
  ring.style.top = '50%';
  ring.style.left = '50%';
  ring.style.width = `${RING_SIZE}px`;
  ring.style.height = `${RING_SIZE}px`;
  ring.style.marginLeft = `-${RING_SIZE / 2}px`;
  ring.style.marginTop = `-${RING_SIZE / 2}px`;
  ring.style.borderRadius = '50%';
  ring.style.border = `3px solid ${SELECTED_RING_COLOR}`;
  ring.style.boxShadow = `0 0 8px 2px ${SELECTED_RING_COLOR}`;
  ring.style.pointerEvents = 'none';
  ring.style.opacity = '0';
  ring.style.transition = 'opacity 0.15s ease';
  return ring;
}

export function createVehicleMarkerElement({ deviceId, isMine, color }: VehicleMarkerOptions): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'vehicle-marker';
  el.style.position = 'relative';
  el.style.width = `${ARROW_SIZE}px`;
  el.style.height = `${ARROW_SIZE}px`;
  el.style.cursor = 'pointer';

  el.appendChild(createSelectionRing());
  el.appendChild(createHeadingArrow(color));

  const label = document.createElement('div');
  label.className = 'vehicle-marker__label';
  label.style.position = 'absolute';
  label.style.top = '100%';
  label.style.left = '50%';
  label.style.transform = 'translateX(-50%)';
  label.style.marginTop = '2px';
  label.style.padding = '1px 5px';
  label.style.borderRadius = '4px';
  label.style.background = 'rgba(11, 13, 16, 0.85)';
  label.style.color = color;
  label.style.fontSize = '10px';
  label.style.fontWeight = 'bold';
  label.style.whiteSpace = 'nowrap';
  label.style.pointerEvents = 'none';
  label.textContent = isMine ? 'YO' : shortVehicleLabel(deviceId);
  el.appendChild(label);

  return el;
}

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
  arrow.style.opacity = stopped ? '0.55' : '1';
}

// agrega/quita el anillo amarillo - nunca toca el color de relleno (identidad/estado), así un
// vehículo sigue siendo reconocible como "mío" o "desconectado" incluso mientras está seleccionado
export function setVehicleMarkerSelected(el: HTMLElement, isSelected: boolean): void {
  const ring = el.querySelector<HTMLDivElement>('.vehicle-marker__ring');
  if (!ring) return;
  ring.style.opacity = isSelected ? '1' : '0';
  el.classList.toggle('vehicle-marker--selected', isSelected);
}

export function setVehicleMarkerThreat(el: HTMLElement, isThreat: boolean): void {
  el.classList.toggle('vehicle-marker--threat', isThreat);
}

// desconectado/sin señal reciente - cambia el color de relleno a rojo (antes solo bajaba
// la opacidad, mucho menos perceptible a simple vista) y restaura el color base al reconectar
export function setVehicleMarkerStale(el: HTMLElement, isStale: boolean): void {
  el.classList.toggle('vehicle-marker--stale', isStale);

  const arrow = el.querySelector<HTMLDivElement>('.vehicle-marker__arrow');
  const path = arrow?.querySelector('path');
  if (!arrow || !path) return;

  const baseColor = arrow.dataset.baseColor ?? OFFLINE_COLOR;
  const fill = isStale ? OFFLINE_COLOR : baseColor;
  path.setAttribute('fill', fill);
  arrow.style.filter = `drop-shadow(0 0 4px ${fill}) drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6))`;
}
