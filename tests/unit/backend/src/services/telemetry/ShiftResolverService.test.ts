import { describe, expect, it } from 'vitest';
import { mostRecentShiftStart, resolveShiftForTime } from '../../../../../../backend/src/services/telemetry/ShiftResolverService';

function at(hh: number, mm: number): Date {
  const d = new Date(2026, 0, 1, hh, mm, 0);
  return d;
}

describe('resolveShiftForTime', () => {
  it('resuelve un turno simple dentro del mismo día', () => {
    const shifts = [{ id: 1, start_time: '07:00:00', end_time: '15:00:00' }];
    expect(resolveShiftForTime(shifts, at(9, 0))).toBe(1);
    expect(resolveShiftForTime(shifts, at(6, 59))).toBe(null);
    expect(resolveShiftForTime(shifts, at(15, 0))).toBe(null); // end exclusivo
  });

  it('resuelve un turno que cruza medianoche', () => {
    const shifts = [{ id: 2, start_time: '22:00:00', end_time: '06:00:00' }];
    expect(resolveShiftForTime(shifts, at(23, 30))).toBe(2);
    expect(resolveShiftForTime(shifts, at(2, 0))).toBe(2);
    expect(resolveShiftForTime(shifts, at(12, 0))).toBe(null);
  });

  it('elige el primer turno que coincide si hay varios (no deberían solaparse, pero no truena si pasa)', () => {
    const shifts = [
      { id: 1, start_time: '07:00:00', end_time: '15:00:00' },
      { id: 2, start_time: '15:00:00', end_time: '23:00:00' },
    ];
    expect(resolveShiftForTime(shifts, at(16, 0))).toBe(2);
    expect(resolveShiftForTime(shifts, at(8, 0))).toBe(1);
  });

  it('devuelve null si ningún turno cubre la hora actual', () => {
    expect(resolveShiftForTime([], at(9, 0))).toBe(null);
  });
});

describe('mostRecentShiftStart', () => {
  it('si la hora de inicio ya pasó hoy, devuelve hoy a esa hora', () => {
    expect(mostRecentShiftStart('07:00', at(9, 0))).toEqual(new Date(2026, 0, 1, 7, 0, 0, 0));
  });

  it('si la hora de inicio todavía no llega hoy, devuelve ayer a esa hora', () => {
    expect(mostRecentShiftStart('07:00', at(6, 0))).toEqual(new Date(2025, 11, 31, 7, 0, 0, 0));
  });

  it('caso límite - "ahora" es exactamente la hora de inicio, devuelve hoy (no ayer)', () => {
    expect(mostRecentShiftStart('07:00', at(7, 0))).toEqual(new Date(2026, 0, 1, 7, 0, 0, 0));
  });
});
