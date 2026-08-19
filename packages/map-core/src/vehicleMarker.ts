const MIN_MOVING_SPEED_MPS = 0.5;
const MARKER_SIZE = 40;
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
  el.textContent = isMine ? 'YO' : shortVehicleLabel(deviceId);

  el.appendChild(createHeadingArrow(color));
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
  arrow.style.opacity = stopped ? '0.4' : '1';
}

export function setVehicleMarkerThreat(el: HTMLElement, isThreat: boolean): void {
  el.classList.toggle('vehicle-marker--threat', isThreat);
}

export function setVehicleMarkerStale(el: HTMLElement, isStale: boolean): void {
  el.classList.toggle('vehicle-marker--stale', isStale);
  el.style.opacity = isStale ? '0.4' : '1';
}
