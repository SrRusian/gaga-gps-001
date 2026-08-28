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

// requiere TZ=America/Mexico_City en el proceso - getHours() usa la hora local
export function resolveShiftForTime(
  shifts: ShiftTimeRange[],
  now: Date = new Date(),
): number | null {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  for (const shift of shifts) {
    const start = toMinutesOfDay(shift.start_time);
    const end = toMinutesOfDay(shift.end_time);
    // start > end = turno cruza medianoche
    const matches = start <= end ? nowMinutes >= start && nowMinutes < end : nowMinutes >= start || nowMinutes < end;
    if (matches) return shift.id;
  }
  return null;
}

export function mostRecentShiftStart(startTime: string, now: Date = new Date()): Date {
  const [hours, minutes] = startTime.split(':').map(Number);
  const candidate = new Date(now);
  candidate.setHours(hours, minutes, 0, 0);
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
