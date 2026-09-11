import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SignalLostService from '../../../../../../backend/src/services/alerts/SignalLostService';

describe('SignalLostService', () => {
  let socketServer: {
    sendToDevice: ReturnType<typeof vi.fn<(deviceId: string, event: string, payload: unknown) => void>>;
    broadcastToProject: ReturnType<
      typeof vi.fn<(projectId: number | null, event: string, payload: unknown) => void>
    >;
    broadcastToProjectExceptDevice: ReturnType<
      typeof vi.fn<
        (projectId: number | null, excludeDeviceId: string, event: string, payload: unknown) => void
      >
    >;
  };
  let preventiveStopService: {
    isActive: boolean;
    activate: ReturnType<typeof vi.fn<(reason: string, triggeredBy?: string) => void>>;
  };
  let service: InstanceType<typeof SignalLostService>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    socketServer = {
      sendToDevice: vi.fn(),
      broadcastToProject: vi.fn(),
      broadcastToProjectExceptDevice: vi.fn(),
    };
    preventiveStopService = {
      isActive: false,
      activate: vi.fn<(reason: string, triggeredBy?: string) => void>(),
    };
    service = new SignalLostService({ socketServer, preventiveStopService });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('no dispara nada mientras el dispositivo reporta a tiempo', () => {
    service.recordPosition('T1');
    service.checkAllDevices();
    expect(socketServer.sendToDevice).not.toHaveBeenCalled();
    expect(socketServer.broadcastToProjectExceptDevice).not.toHaveBeenCalled();
  });

  it('dispara nivel 1 a partir de 10s sin señal - deviceId real (texto), nunca parseInt/NaN', () => {
    service.recordPosition('T1');
    vi.advanceTimersByTime(10000);
    service.checkAllDevices();

    // al propio vehiculo, mensaje en primera persona
    expect(socketServer.sendToDevice).toHaveBeenCalledWith(
      'T1',
      'signal:lost:level1',
      expect.objectContaining({ deviceId: 'T1', elapsedSeconds: 10, message: expect.stringContaining('PERDISTE') }),
    );
    // al resto del proyecto, mensaje en tercera persona nombrando el vehiculo
    expect(socketServer.broadcastToProjectExceptDevice).toHaveBeenCalledWith(
      null,
      'T1',
      'signal:lost:level1',
      expect.objectContaining({ deviceId: 'T1', message: expect.stringContaining('VEHÍCULO T1') }),
    );
    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      null,
      'supervisor:signal_lost',
      expect.objectContaining({ deviceId: 'T1', level: 1 }),
    );
  });

  it('usa el projectId reportado en recordPosition para dirigir el broadcast', () => {
    service.recordPosition('T1', 7);
    vi.advanceTimersByTime(10000);
    service.checkAllDevices();

    expect(socketServer.broadcastToProjectExceptDevice).toHaveBeenCalledWith(
      7,
      'T1',
      'signal:lost:level1',
      expect.anything(),
    );
  });

  it('no repite nivel 1 en cada chequeo mientras siga en el mismo nivel', () => {
    service.recordPosition('T1');
    vi.advanceTimersByTime(10000);
    service.checkAllDevices();
    socketServer.sendToDevice.mockClear();
    socketServer.broadcastToProjectExceptDevice.mockClear();
    vi.advanceTimersByTime(5000);
    service.checkAllDevices();
    expect(socketServer.sendToDevice).not.toHaveBeenCalled();
    expect(socketServer.broadcastToProjectExceptDevice).not.toHaveBeenCalled();
  });

  it('escala a nivel 2 a partir de 20s y activa la parada preventiva automáticamente', () => {
    service.recordPosition('T1');
    vi.advanceTimersByTime(20000);
    service.checkAllDevices();

    expect(socketServer.sendToDevice).toHaveBeenCalledWith(
      'T1',
      'signal:lost:level2',
      expect.objectContaining({ deviceId: 'T1', elapsedSeconds: 20, loop: true }),
    );
    expect(preventiveStopService.activate).toHaveBeenCalledWith(
      expect.stringContaining('T1'),
      'auto',
    );
  });

  it('NO activa la parada preventiva si ya está activa', () => {
    preventiveStopService.isActive = true;
    service.recordPosition('T1');
    vi.advanceTimersByTime(20000);
    service.checkAllDevices();
    expect(preventiveStopService.activate).not.toHaveBeenCalled();
  });

  it('recordPosition emite signal:recovered (a ambas audiencias) si el dispositivo estaba en alerta', () => {
    service.recordPosition('T1');
    vi.advanceTimersByTime(10000);
    service.checkAllDevices();
    socketServer.sendToDevice.mockClear();
    socketServer.broadcastToProjectExceptDevice.mockClear();
    socketServer.broadcastToProject.mockClear();

    service.recordPosition('T1');
    expect(socketServer.sendToDevice).toHaveBeenCalledWith(
      'T1',
      'signal:recovered',
      expect.objectContaining({ deviceId: 'T1', message: expect.stringContaining('RECUPERASTE') }),
    );
    expect(socketServer.broadcastToProjectExceptDevice).toHaveBeenCalledWith(
      null,
      'T1',
      'signal:recovered',
      expect.objectContaining({ deviceId: 'T1', message: expect.stringContaining('VEHÍCULO T1') }),
    );
    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      null,
      'supervisor:signal_lost',
      expect.objectContaining({ deviceId: 'T1', level: 0 }),
    );
  });

  it('recordPosition en un dispositivo que nunca estuvo perdido no emite signal:recovered', () => {
    service.recordPosition('T1');
    expect(socketServer.sendToDevice).not.toHaveBeenCalled();
  });

  it('stopMonitoring limpia el intervalo sin lanzar si nunca se inició', () => {
    expect(() => service.stopMonitoring()).not.toThrow();
  });

  it('funciona sin socketServer (se asigna despues, ver app.ts) - no lanza al llegar a nivel 1', () => {
    const withoutSocket = new SignalLostService({ preventiveStopService });
    withoutSocket.recordPosition('T1');
    vi.advanceTimersByTime(10000);
    expect(() => withoutSocket.checkAllDevices()).not.toThrow();
  });

  it('marca el dispositivo offline en PostgreSQL (vía deviceManager) al llegar a nivel 1 - sin esto el panel admin lo muestra "online" para siempre', () => {
    const deviceManager = { markOffline: vi.fn().mockResolvedValue(undefined) };
    const withDeviceManager = new SignalLostService({ socketServer, preventiveStopService, deviceManager });

    withDeviceManager.recordPosition('CAMION-01');
    vi.advanceTimersByTime(10000);
    withDeviceManager.checkAllDevices();

    expect(deviceManager.markOffline).toHaveBeenCalledWith('CAMION-01');
  });

  it('funciona sin deviceManager (dependencia opcional) - no lanza al llegar a nivel 1', () => {
    service.recordPosition('CAMION-01');
    vi.advanceTimersByTime(10000);
    expect(() => service.checkAllDevices()).not.toThrow();
  });

  it('hydrate siembra lastSeen y projectId para que un dispositivo ya viejo desde antes del reinicio se re-evalúe de inmediato', () => {
    service.hydrate([{ deviceId: 'CAMION-VIEJO', lastSeenAt: new Date(Date.now() - 30000), projectId: 3 }]);
    service.checkAllDevices();

    expect(socketServer.broadcastToProjectExceptDevice).toHaveBeenCalledWith(
      3,
      'CAMION-VIEJO',
      'signal:lost:level2',
      expect.objectContaining({ deviceId: 'CAMION-VIEJO', elapsedSeconds: 30 }),
    );
  });

  it('marca offline también cuando un dispositivo salta directo a nivel 2 (sin pasar por nivel 1) - caso real: hydrate() de un dispositivo silencioso desde horas antes del reinicio', () => {
    const deviceManager = { markOffline: vi.fn().mockResolvedValue(undefined) };
    const withDeviceManager = new SignalLostService({ socketServer, preventiveStopService, deviceManager });

    withDeviceManager.hydrate([
      { deviceId: 'TABLETA-VIEJA', lastSeenAt: new Date(Date.now() - 46739000), projectId: null },
    ]);
    withDeviceManager.checkAllDevices();

    expect(socketServer.sendToDevice).toHaveBeenCalledWith('TABLETA-VIEJA', 'signal:lost:level2', expect.anything());
    expect(socketServer.sendToDevice).not.toHaveBeenCalledWith(
      'TABLETA-VIEJA',
      'signal:lost:level1',
      expect.anything(),
    );
    expect(deviceManager.markOffline).toHaveBeenCalledWith('TABLETA-VIEJA');
  });
});
