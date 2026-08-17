/**
 * ShiftResolverService.ts
 *
 * Responsabilidad: Resolver a qué turno programado (shifts) pertenece
 * "ahora mismo" dentro de un proyecto - se llama al iniciar un turno
 * de operador (operator-sessions.routes.ts /start) para completar
 * `shift_id` automáticamente, sin que el operador elija nada.
 *
 * Puramente cinemático respecto al reloj: compara la hora del día
 * actual contra el rango start_time/end_time de cada turno activo
 * del proyecto. Requiere que el proceso corra en la zona horaria
 * real de la operación (TZ=America/Mexico_City, ver docker-compose.yml)
 * - si no, "ahora" no coincide con lo que el Encargado configuró
 * pensando en hora local.
 */
import type ShiftRepository from '../../repositories/ShiftRepository';

export interface ShiftTimeRange {
  id: number;
  start_time: string;
  end_time: string;
}

function toMinutesOfDay(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Función pura - separada de la clase para poder probarla sin mocks
 * de repositorio/DB. `end_time < start_time` significa que el turno
 * cruza medianoche (ej. 22:00–06:00).
 */
export function resolveShiftForTime(
  shifts: ShiftTimeRange[],
  now: Date = new Date(),
): number | null {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  for (const shift of shifts) {
    const start = toMinutesOfDay(shift.start_time);
    const end = toMinutesOfDay(shift.end_time);
    const matches = start <= end ? nowMinutes >= start && nowMinutes < end : nowMinutes >= start || nowMinutes < end;
    if (matches) return shift.id;
  }
  return null;
}

/**
 * A diferencia de `resolveShiftForTime` (que hace matching de una
 * ventana completa start/end para saber A CUÁL turno pertenece
 * "ahora"), esto solo resuelve un límite inferior: "¿desde cuándo
 * empezó el turno actual/más reciente?" - usado para acotar el
 * historial de alertas de un Supervisor a su propio turno. Nunca mira
 * `end_time` porque no hace falta para esa pregunta.
 */
export function mostRecentShiftStart(startTime: string, now: Date = new Date()): Date {
  const [hours, minutes] = startTime.split(':').map(Number);
  const candidate = new Date(now);
  candidate.setHours(hours, minutes, 0, 0);
  // Comparación estricta (>, no >=) - si "ahora" es exactamente la
  // hora de inicio, el turno ya empezó hoy, no hay que restar un día.
  if (candidate > now) {
    candidate.setDate(candidate.getDate() - 1);
  }
  return candidate;
}

class ShiftResolverService {
  shiftRepo: ShiftRepository;

  constructor({ shiftRepo }: { shiftRepo: ShiftRepository }) {
    this.shiftRepo = shiftRepo;
  }

  async resolveForProject(projectId: number, now: Date = new Date()): Promise<number | null> {
    const shifts = await this.shiftRepo.findActiveByProject(projectId);
    return resolveShiftForTime(shifts, now);
  }

  /**
   * Límite inferior para acotar el historial de alertas de un
   * Supervisor de Proyecto a su propio turno (`alerts.routes.ts`).
   * `null` si no tiene ningún turno asignado - en ese caso no hay
   * límite que aplicar, se deja el comportamiento sin acotar. Un
   * Supervisor asignado a más de un turno (caso raro, lo normal es
   * 1:1) usa el límite más permisivo (el más antiguo de los
   * calculados), no el más estricto.
   */
  async mostRecentShiftStartForSupervisor(
    supervisorUserId: number,
    now: Date = new Date(),
  ): Promise<Date | null> {
    const shifts = await this.shiftRepo.findBySupervisor(supervisorUserId);
    if (shifts.length === 0) return null;
    return shifts
      .map((shift) => mostRecentShiftStart(shift.start_time, now))
      .reduce((earliest, candidate) => (candidate < earliest ? candidate : earliest));
  }
}

export default ShiftResolverService;
