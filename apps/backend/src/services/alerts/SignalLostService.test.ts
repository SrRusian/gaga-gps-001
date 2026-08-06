// Test de caracterización — congela el comportamiento actual ANTES
// de convertir a TypeScript. Usa fake timers de Vitest en vez de
// startMonitoring() real (setInterval de 5s) para no depender de
// tiempo real en el test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SignalLostService from './SignalLostService';

describe('SignalLostService', () => {
  let io: { emit: ReturnType<typeof vi.fn> };
  let preventiveStopService: { isActive: boolean; activate: ReturnType<typeof vi.fn> };
  let service: InstanceType<typeof SignalLostService>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    io = { emit: vi.fn() };
    preventiveStopService = { isActive: false, activate: vi.fn() };
    service = new SignalLostService({ io, preventiveStopService });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('no dispara nada mientras el dispositivo reporta a tiempo', () => {
    service.recordPosition(1);
    service.checkAllDevices();
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('dispara nivel 1 a partir de 45s sin señal', () => {
    service.recordPosition(1);
    vi.advanceTimersByTime(45000);
    service.checkAllDevices();

    expect(io.emit).toHaveBeenCalledWith(
      'signal:lost:level1',
      expect.objectContaining({ deviceId: 1, elapsedSeconds: 45 }),
    );
    expect(io.emit).toHaveBeenCalledWith(
      'supervisor:signal_lost',
      expect.objectContaining({ deviceId: 1, level: 1 }),
    );
  });

  it('no repite nivel 1 en cada chequeo mientras siga en el mismo nivel', () => {
    service.recordPosition(1);
    vi.advanceTimersByTime(45000);
    service.checkAllDevices();
    io.emit.mockClear();
    vi.advanceTimersByTime(5000); // sigue en nivel 1, aún no llega a 90s
    service.checkAllDevices();
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('escala a nivel 2 a partir de 90s y activa la parada preventiva automáticamente', () => {
    service.recordPosition(1);
    vi.advanceTimersByTime(90000);
    service.checkAllDevices();

    expect(io.emit).toHaveBeenCalledWith(
      'signal:lost:level2',
      expect.objectContaining({ deviceId: 1, elapsedSeconds: 90, loop: true }),
    );
    expect(preventiveStopService.activate).toHaveBeenCalledWith(
      expect.stringContaining('1'),
      'auto',
    );
  });

  it('NO activa la parada preventiva si ya está activa', () => {
    preventiveStopService.isActive = true;
    service.recordPosition(1);
    vi.advanceTimersByTime(90000);
    service.checkAllDevices();
    expect(preventiveStopService.activate).not.toHaveBeenCalled();
  });

  it('recordPosition emite signal:recovered si el dispositivo estaba en alerta', () => {
    service.recordPosition(1);
    vi.advanceTimersByTime(45000);
    service.checkAllDevices(); // nivel 1
    io.emit.mockClear();

    service.recordPosition(1); // vuelve a reportar
    expect(io.emit).toHaveBeenCalledWith(
      'signal:recovered',
      expect.objectContaining({ deviceId: 1 }),
    );
    expect(io.emit).toHaveBeenCalledWith(
      'supervisor:signal_lost',
      expect.objectContaining({ deviceId: 1, level: 0 }),
    );
  });

  it('recordPosition en un dispositivo que nunca estuvo perdido no emite signal:recovered', () => {
    service.recordPosition(1);
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('deviceId se convierte con parseInt en los payloads emitidos — con un id no-numérico da NaN', () => {
    // Quirk real del código actual: el deviceId real del sistema
    // siempre es numérico (id de la tabla devices), pero si alguna
    // vez llegara un id no-numérico, esto silenciosamente emite NaN
    // en vez de fallar. Se deja documentado aquí para que la
    // conversión a TypeScript no "corrija" esto sin que sea una
    // decisión consciente.
    service.recordPosition('V1');
    vi.advanceTimersByTime(45000);
    service.checkAllDevices();
    expect(io.emit).toHaveBeenCalledWith(
      'signal:lost:level1',
      expect.objectContaining({ deviceId: Number.NaN }),
    );
  });

  it('stopMonitoring limpia el intervalo sin lanzar si nunca se inició', () => {
    expect(() => service.stopMonitoring()).not.toThrow();
  });
});
