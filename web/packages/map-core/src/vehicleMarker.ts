import type { Map as MaplibreMap } from 'maplibre-gl';

const MIN_MOVING_SPEED_MPS = 0.5;
// Módulo círculo de precisión del vehículo (No modificar)
// mismo criterio que web/packages/map-core/src/geofenceLayer.ts (duplicado a propósito, ver nota
// de ese archivo) - para desplazar un punto una distancia real hacia el este
const METERS_PER_DEG_LAT = 111320;
const ARROW_SIZE = 34;
const RING_SIZE = ARROW_SIZE + 14;
// mismos valores que colors.danger/colors.selected en @gaga-gps/ui - duplicados a propósito,
// este paquete no depende de web/packages/ui (ver EQUIPMENT_CORE_COLOR/EQUIPMENT_OUTER_COLOR, mismo criterio)
const SELECTED_RING_COLOR = '#ffd23f';
const OFFLINE_COLOR = '#e5484d';
const ACCURACY_COLOR = '#008cff';
// color distinto a proposito del circulo de precision (azul) y de los colores de identidad
// (mio/otro/desconectado/seleccionado) - representa una medida fisica fija, no un estado
const FOOTPRINT_COLOR = '#94a3b8';
// solo se usa cuando no hay accuracy reportada (undefined) - nunca reemplaza un valor real, por
// chico o grande que sea, el círculo debe representar la precisión real del GPS sin piso artificial
const DEFAULT_ACCURACY_METERS = 15;
const ACCURACY_INITIAL_DIAMETER_PX = ARROW_SIZE + 10;
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
  clickable?: boolean;
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

// Módulo círculo de precisión del vehículo (No modificar)
// círculo de precisión GPS - hijo del propio marcador (no una capa de mapa aparte), así queda
// SIEMPRE centrado en la flecha por construcción, sin depender de sincronizar dos sistemas de
// coordenadas distintos (lo que causaba el desfase durante el deslizamiento suave del marcador)
function createAccuracyCircle(): HTMLDivElement {
  const circle = document.createElement('div');
  circle.className = 'vehicle-marker__accuracy';
  circle.style.position = 'absolute';
  circle.style.top = '50%';
  circle.style.left = '50%';
  circle.style.transform = 'translate(-50%, -50%)';
  circle.style.borderRadius = '50%';
  circle.style.background = `${ACCURACY_COLOR}1f`;
  circle.style.border = `1px solid ${ACCURACY_COLOR}66`;
  circle.style.pointerEvents = 'none';
  // sin transición: el mapa mismo no anima su propio zoom con easing extra (cada frame cambia
  // de tamaño al instante), así que animar el círculo aparte solo lo desincroniza - con zoom
  // rápido (rueda del mouse) cada evento reinicia la transición antes de que termine la
  // anterior, y el círculo nunca alcanza a "ponerse al día" con su tamaño real
  circle.style.width = `${ACCURACY_INITIAL_DIAMETER_PX}px`;
  circle.style.height = `${ACCURACY_INITIAL_DIAMETER_PX}px`;
  return circle;
}

// silueta real del vehiculo (largo x ancho en metros, ver vehicle_types) - rectangulo centrado en
// el mismo punto que el resto del marcador, que rota junto con la flecha (updateVehicleMarkerHeading)
// para que su "frente" siempre coincida con hacia donde apunta. Oculto por defecto (display:none)
// hasta que setVehicleMarkerFootprint reciba dimensiones reales - la mayoria de dispositivos no
// tendran un tipo de vehiculo asignado de entrada. Se crea PRIMERO (mas atras en el DOM) para que
// el circulo de precision y la flecha se dibujen encima - con RTK centimetrico el circulo de
// precision puede ser mucho mas chico que el propio vehiculo, así que el rectangulo actua como el
// "cuerpo" de fondo y el resto de elementos son indicadores mas finos sobre el.
function createVehicleFootprint(): HTMLDivElement {
  const footprint = document.createElement('div');
  footprint.className = 'vehicle-marker__footprint';
  footprint.style.position = 'absolute';
  footprint.style.top = '50%';
  footprint.style.left = '50%';
  footprint.style.background = `${FOOTPRINT_COLOR}33`;
  footprint.style.border = `1.5px solid ${FOOTPRINT_COLOR}cc`;
  footprint.style.borderRadius = '3px';
  footprint.style.pointerEvents = 'none';
  footprint.style.display = 'none';
  return footprint;
}

export function createVehicleMarkerElement({
  color,
  clickable = true,
}: VehicleMarkerOptions): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'vehicle-marker';
  // DEBE ser absolute: MapLibre posiciona el marcador escribiendo un transform en ESTE mismo
  // elemento, y su hoja de estilos lo deja en `position:absolute; top:0; left:0` para que ese
  // transform se mida desde el origen del contenedor del mapa. Un `relative` inline le gana a esa
  // regla de clase y devuelve el marcador al flujo normal del documento: cada marcador queda
  // apilado 34px mas abajo que el anterior y el transform lo desplaza desde ahi, no desde el
  // origen. Bug real reportado en campo: el primer vehiculo se veia bien y los demas aparecian
  // corridos hacia el sur una cantidad fija de PIXELES - imperceptible con zoom cercano, pero
  // decenas de km al alejar. Sigue siendo bloque contenedor de los hijos absolutos igual que antes.
  el.style.position = 'absolute';
  el.style.width = `${ARROW_SIZE}px`;
  el.style.height = `${ARROW_SIZE}px`;
  el.style.cursor = clickable ? 'pointer' : 'default';

  el.appendChild(createVehicleFootprint());
  el.appendChild(createAccuracyCircle()); // Módulo círculo de precisión del vehículo (No modificar)
  el.appendChild(createSelectionRing());
  el.appendChild(createHeadingArrow(color));

  return el;
}

// Módulo círculo de precisión del vehículo (No modificar)
// tamaño del círculo en PIXELES de pantalla reales, medido con map.project() - la MISMA
// proyección que usa MapLibre para dibujar geocercas y todo lo demás, en vez de mantener una
// fórmula aparte que tiene que coincidir a mano con el zoom interno de la librería (eso fue lo
// que causaba el círculo desproporcionado frente a una geocerca real del mismo radio)
export function setVehicleMarkerAccuracy(
  el: HTMLElement,
  map: MaplibreMap,
  latitude: number,
  longitude: number,
  accuracyMeters: number | undefined,
): void {
  const circle = el.querySelector<HTMLDivElement>('.vehicle-marker__accuracy');
  if (!circle) return;

  const radiusMeters = accuracyMeters ?? DEFAULT_ACCURACY_METERS;
  const dLat = radiusMeters / METERS_PER_DEG_LAT;
  const center = map.project([longitude, latitude]);
  const edge = map.project([longitude, latitude + dLat]);
  const radiusPx = Math.hypot(edge.x - center.x, edge.y - center.y);
  const diameterPx = radiusPx * 2;
  circle.style.width = `${diameterPx}px`;
  circle.style.height = `${diameterPx}px`;
}

// silueta real del vehiculo - mismo truco de map.project() que setVehicleMarkerAccuracy para medir
// metros reales en pixeles de pantalla al zoom actual. Un solo factor px/metro (medido en el eje
// norte-sur) se usa para largo Y ancho a la vez - la distorsion este-oeste de la proyeccion es
// despreciable al nivel de zoom en el que se rastrean vehiculos, y usar un solo factor evita que
// el rectangulo se deforme al rotar (el largo siempre debe verse igual de largo sin importar hacia
// donde apunte la flecha). Oculta el rectangulo (sin tipo de vehiculo asignado) si falta cualquiera
// de las dos medidas - nunca dibuja un tamaño inventado.
export function setVehicleMarkerFootprint(
  el: HTMLElement,
  map: MaplibreMap,
  latitude: number,
  longitude: number,
  lengthMeters: number | null | undefined,
  widthMeters: number | null | undefined,
): void {
  const footprint = el.querySelector<HTMLDivElement>('.vehicle-marker__footprint');
  if (!footprint) return;

  if (!lengthMeters || !widthMeters || lengthMeters <= 0 || widthMeters <= 0) {
    footprint.style.display = 'none';
    return;
  }

  const dLat = 1 / METERS_PER_DEG_LAT; // 1 metro en grados de latitud, para medir px/metro
  const center = map.project([longitude, latitude]);
  const edge = map.project([longitude, latitude + dLat]);
  const pxPerMeter = Math.hypot(edge.x - center.x, edge.y - center.y);
  const widthPx = widthMeters * pxPerMeter;
  const heightPx = lengthMeters * pxPerMeter;

  footprint.style.display = 'block';
  footprint.style.width = `${widthPx}px`;
  footprint.style.height = `${heightPx}px`;
  // centrado por margen (no transform:translate) para no pelear con la rotacion, que
  // updateVehicleMarkerHeading/realignVehicleMarkerToBearing escriben en style.transform aparte
  footprint.style.marginLeft = `-${widthPx / 2}px`;
  footprint.style.marginTop = `-${heightPx / 2}px`;
}

// mapBearing (grados, default 0 = sin cambio para Admin/Supervisor cuyo mapa nunca rota) resta el
// rumbo del mapa al rumbo real del vehiculo - asi en modo "orientado al frente" (mapa rotado para
// que el vehiculo seguido siempre apunte hacia arriba) el resto de los vehiculos se ven girados
// correctamente en pantalla, no con su rumbo geografico crudo
export function updateVehicleMarkerHeading(
  el: HTMLElement,
  deviceId: string,
  course: number | undefined,
  speed: number | undefined,
  mapBearing = 0,
): void {
  const arrow = el.querySelector<HTMLDivElement>('.vehicle-marker__arrow');
  if (!arrow) return;

  const { course: resolvedCourse, stopped } = resolveVehicleCourse(deviceId, course, speed);
  // se guarda el rumbo geografico ya resuelto (no el crudo) para que realignVehicleMarkerToBearing
  // pueda re-aplicar solo la rotacion en pantalla cuando el mapa gira, sin volver a decidir
  // "detenido/en movimiento" (eso solo debe cambiar cuando llega una posicion real)
  arrow.dataset.course = String(resolvedCourse);
  arrow.style.transform = `rotate(${resolvedCourse - mapBearing}deg)`;
  arrow.style.opacity = stopped ? '0.55' : '1';

  // la silueta del vehiculo gira junto con la flecha, siempre con el mismo rumbo - asi su "frente"
  // coincide con hacia donde apunta la flecha
  const footprint = el.querySelector<HTMLDivElement>('.vehicle-marker__footprint');
  if (footprint) footprint.style.transform = `rotate(${resolvedCourse - mapBearing}deg)`;
}

// re-aplica solo la orientacion en pantalla de un marcador ya existente cuando cambia el rumbo del
// mapa (evento 'rotate') - lee el rumbo geografico guardado por updateVehicleMarkerHeading, no
// vuelve a tocar opacidad/estado de "detenido"
export function realignVehicleMarkerToBearing(el: HTMLElement, mapBearing: number): void {
  const arrow = el.querySelector<HTMLDivElement>('.vehicle-marker__arrow');
  if (!arrow) return;
  const course = Number(arrow.dataset.course ?? '0');
  arrow.style.transform = `rotate(${course - mapBearing}deg)`;

  const footprint = el.querySelector<HTMLDivElement>('.vehicle-marker__footprint');
  if (footprint) footprint.style.transform = `rotate(${course - mapBearing}deg)`;
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
