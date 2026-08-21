const MIN_MOVING_SPEED_MPS = 0.5;
const ARROW_SIZE = 34;
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
  arrow.style.top = '50%';
  arrow.style.left = '50%';
  arrow.style.width = `${ARROW_SIZE}px`;
  arrow.style.height = `${ARROW_SIZE}px`;
  arrow.style.marginLeft = `-${ARROW_SIZE / 2}px`;
  arrow.style.marginTop = `-${ARROW_SIZE / 2}px`;
  arrow.style.pointerEvents = 'none';
  arrow.style.transition = 'opacity 0.3s ease';
  arrow.style.filter = `drop-shadow(0 0 4px ${color}) drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6))`;
  arrow.innerHTML = `
    <svg viewBox="0 0 24 24" width="${ARROW_SIZE}" height="${ARROW_SIZE}">
      <path d="M12 2L4.5 20.29 5.21 21 12 18 18.79 21 19.5 20.29z"
            fill="${color}" stroke="#0b0d10" stroke-width="1.5" stroke-linejoin="round" />
    </svg>
  `;

  return arrow;
}

export function createVehicleMarkerElement({ deviceId, isMine, color }: VehicleMarkerOptions): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'vehicle-marker';
  el.style.position = 'relative';
  el.style.width = `${ARROW_SIZE}px`;
  el.style.height = `${ARROW_SIZE}px`;
  el.style.cursor = 'pointer';

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

export function setVehicleMarkerThreat(el: HTMLElement, isThreat: boolean): void {
  el.classList.toggle('vehicle-marker--threat', isThreat);
}

export function setVehicleMarkerStale(el: HTMLElement, isStale: boolean): void {
  el.classList.toggle('vehicle-marker--stale', isStale);
  el.style.opacity = isStale ? '0.4' : '1';
}
