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

  it('dispara nivel 1 a partir de 10s sin señal', () => {
    service.recordPosition(1);
    vi.advanceTimersByTime(10000);
    service.checkAllDevices();

    expect(io.emit).toHaveBeenCalledWith(
      'signal:lost:level1',
      expect.objectContaining({ deviceId: 1, elapsedSeconds: 10 }),
    );
    expect(io.emit).toHaveBeenCalledWith(
      'supervisor:signal_lost',
      expect.objectContaining({ deviceId: 1, level: 1 }),
    );
  });

  it('no repite nivel 1 en cada chequeo mientras siga en el mismo nivel', () => {
    service.recordPosition(1);
    vi.advanceTimersByTime(10000);
    service.checkAllDevices();
    io.emit.mockClear();
    vi.advanceTimersByTime(5000); // sigue en nivel 1, aún no llega a 20s
    service.checkAllDevices();
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('escala a nivel 2 a partir de 20s y activa la parada preventiva automáticamente', () => {
    service.recordPosition(1);
    vi.advanceTimersByTime(20000);
    service.checkAllDevices();

    expect(io.emit).toHaveBeenCalledWith(
      'signal:lost:level2',
      expect.objectContaining({ deviceId: 1, elapsedSeconds: 20, loop: true }),
    );
    expect(preventiveStopService.activate).toHaveBeenCalledWith(
      expect.stringContaining('1'),
      'auto',
    );
  });

  it('NO activa la parada preventiva si ya está activa', () => {
    preventiveStopService.isActive = true;
    service.recordPosition(1);
    vi.advanceTimersByTime(20000);
    service.checkAllDevices();
    expect(preventiveStopService.activate).not.toHaveBeenCalled();
  });

  it('recordPosition emite signal:recovered si el dispositivo estaba en alerta', () => {
    service.recordPosition(1);
    vi.advanceTimersByTime(10000);
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
    vi.advanceTimersByTime(10000);
    service.checkAllDevices();
    expect(io.emit).toHaveBeenCalledWith(
      'signal:lost:level1',
      expect.objectContaining({ deviceId: Number.NaN }),
    );
  });

  it('stopMonitoring limpia el intervalo sin lanzar si nunca se inició', () => {
    expect(() => service.stopMonitoring()).not.toThrow();
  });

  it('marca el dispositivo offline en PostgreSQL (vía deviceManager) al llegar a nivel 1 — sin esto el panel admin lo muestra "online" para siempre', () => {
    const deviceManager = { markOffline: vi.fn().mockResolvedValue(undefined) };
    const withDeviceManager = new SignalLostService({ io, preventiveStopService, deviceManager });

    withDeviceManager.recordPosition('CAMION-01');
    vi.advanceTimersByTime(10000);
    withDeviceManager.checkAllDevices();

    expect(deviceManager.markOffline).toHaveBeenCalledWith('CAMION-01');
  });

  it('funciona sin deviceManager (dependencia opcional) — no lanza al llegar a nivel 1', () => {
    service.recordPosition('CAMION-01');
    vi.advanceTimersByTime(10000);
    expect(() => service.checkAllDevices()).not.toThrow();
  });

  it('hydrate siembra lastSeen para que un dispositivo ya viejo desde antes del reinicio se re-evalúe de inmediato', () => {
    // Simula un dispositivo que ya llevaba 30s en silencio ANTES de
    // que este proceso arrancara — sin hydrate(), checkAllDevices()
    // jamás lo vería porque nunca llamó recordPosition en este proceso.
    service.hydrate([{ deviceId: 'CAMION-VIEJO', lastSeenAt: new Date(Date.now() - 30000) }]);
    service.checkAllDevices();

    expect(io.emit).toHaveBeenCalledWith(
      'signal:lost:level2',
      expect.objectContaining({ deviceId: Number.NaN, elapsedSeconds: 30 }),
    );
  });

  it('marca offline también cuando un dispositivo salta directo a nivel 2 (sin pasar por nivel 1) — caso real: hydrate() de un dispositivo silencioso desde horas antes del reinicio', () => {
    const deviceManager = { markOffline: vi.fn().mockResolvedValue(undefined) };
    const withDeviceManager = new SignalLostService({ io, preventiveStopService, deviceManager });

    withDeviceManager.hydrate([
      { deviceId: 'TABLETA-VIEJA', lastSeenAt: new Date(Date.now() - 46739000) },
    ]);
    withDeviceManager.checkAllDevices();

    expect(io.emit).toHaveBeenCalledWith('signal:lost:level2', expect.anything());
    expect(io.emit).not.toHaveBeenCalledWith('signal:lost:level1', expect.anything());
    expect(deviceManager.markOffline).toHaveBeenCalledWith('TABLETA-VIEJA');
  });
});
