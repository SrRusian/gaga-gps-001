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
    activatedBy: 'auto' | 'supervisor' | null;
    activate: ReturnType<typeof vi.fn<(reason: string, triggeredBy?: string) => void>>;
    deactivate: ReturnType<typeof vi.fn<(triggeredBy?: string) => void>>;
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
      activatedBy: null,
      activate: vi.fn<(reason: string, triggeredBy?: string) => void>((_reason, triggeredBy) => {
        preventiveStopService.isActive = true;
        preventiveStopService.activatedBy = (triggeredBy as 'auto' | 'supervisor' | undefined) ?? 'auto';
      }),
      deactivate: vi.fn<(triggeredBy?: string) => void>(() => {
        preventiveStopService.isActive = false;
        preventiveStopService.activatedBy = null;
      }),
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

  it('dispara nivel 1 a partir de 5s sin señal - deviceId real (texto), nunca parseInt/NaN', () => {
    service.recordPosition('T1');
    vi.advanceTimersByTime(5000);
    service.checkAllDevices();

    // al propio vehiculo, mensaje en primera persona
    expect(socketServer.sendToDevice).toHaveBeenCalledWith(
      'T1',
      'signal:lost:level1',
      expect.objectContaining({ deviceId: 'T1', elapsedSeconds: 5, message: expect.stringContaining('PERDISTE') }),
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
    vi.advanceTimersByTime(5000);
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
    vi.advanceTimersByTime(5000);
    service.checkAllDevices();
    socketServer.sendToDevice.mockClear();
    socketServer.broadcastToProjectExceptDevice.mockClear();
    vi.advanceTimersByTime(3000);
    service.checkAllDevices();
    expect(socketServer.sendToDevice).not.toHaveBeenCalled();
    expect(socketServer.broadcastToProjectExceptDevice).not.toHaveBeenCalled();
  });

  it('escala a nivel 2 a partir de 15s, avisando al vehículo y al resto del proyecto', () => {
    service.recordPosition('T1');
    vi.advanceTimersByTime(15000);
    service.checkAllDevices();

    expect(socketServer.sendToDevice).toHaveBeenCalledWith(
      'T1',
      'signal:lost:level2',
      expect.objectContaining({ deviceId: 'T1', elapsedSeconds: 15, loop: true }),
    );
    expect(socketServer.broadcastToProjectExceptDevice).toHaveBeenCalledWith(
      null,
      'T1',
      'signal:lost:level2',
      expect.objectContaining({ message: expect.stringContaining('VEHÍCULO T1') }),
    );
  });

  // decision explicita del usuario: una tableta sin señal ya NO frena a toda la flota. En un viaje
  // real se dispararon 23 paradas globales por baches de cobertura de un solo vehiculo
  it('NUNCA activa la parada preventiva global por una tableta sin señal', () => {
    service.recordPosition('T1');
    vi.advanceTimersByTime(60000);
    service.checkAllDevices();
    expect(preventiveStopService.activate).not.toHaveBeenCalled();
  });

  it('una tableta estacionada en zona permitida no alarma a nadie al quedarse sin señal', () => {
    service.recordPosition('T1');
    service.setZoneExempt('T1', true);
    vi.advanceTimersByTime(60000);
    service.checkAllDevices();
    expect(socketServer.sendToDevice).not.toHaveBeenCalled();
    expect(socketServer.broadcastToProjectExceptDevice).not.toHaveBeenCalled();
  });

  it('NO auto-desactiva una parada preventiva activada manualmente por un supervisor', () => {
    preventiveStopService.isActive = true;
    preventiveStopService.activatedBy = 'supervisor';
    service.recordPosition('T1');
    vi.advanceTimersByTime(20000);
    service.checkAllDevices();

    service.recordPosition('T1');
    expect(preventiveStopService.deactivate).not.toHaveBeenCalled();
    expect(preventiveStopService.isActive).toBe(true);
  });

  it('la reconexion no levanta la alerta al primer paquete: exige 5s de conexion estable', () => {
    service.recordPosition('T1');
    vi.advanceTimersByTime(5000);
    service.checkAllDevices();
    socketServer.sendToDevice.mockClear();

    service.recordPosition('T1'); // primer paquete de vuelta: arranca la ventana, no limpia nada
    expect(socketServer.sendToDevice).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3000);
    service.recordPosition('T1'); // sigue sin cumplir los 5s
    expect(socketServer.sendToDevice).not.toHaveBeenCalled();
  });

  it('una reconexion que se vuelve a caer antes de estabilizarse no limpia la alerta', () => {
    service.recordPosition('T1');
    vi.advanceTimersByTime(5000);
    service.checkAllDevices();
    service.recordPosition('T1'); // arranca la ventana de estabilidad
    socketServer.sendToDevice.mockClear();

    vi.advanceTimersByTime(6000); // se vuelve a caer antes de completarla
    service.checkAllDevices();
    service.recordPosition('T1'); // vuelve: la ventana se reinicia desde cero
    vi.advanceTimersByTime(3000);
    service.recordPosition('T1');
    expect(socketServer.sendToDevice).not.toHaveBeenCalledWith(
      'T1',
      'signal:recovered',
      expect.anything(),
    );
  });

  it('recordPosition emite signal:recovered (a ambas audiencias) tras 5s estable', () => {
    service.recordPosition('T1');
    vi.advanceTimersByTime(5000);
    service.checkAllDevices();
    socketServer.sendToDevice.mockClear();
    socketServer.broadcastToProjectExceptDevice.mockClear();
    socketServer.broadcastToProject.mockClear();

    service.recordPosition('T1');
    vi.advanceTimersByTime(5000);
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

  // Bug real de campo: con la tableta parada en el mismo lugar todo un dia, 32 alertas de senal
  // perdida por huecos de 5-15s del receptor GNSS (perdida de fix bajo techo). Un vehiculo parado
  // que pierde senal unos segundos no es una emergencia; uno EN MOVIMIENTO que desaparece si.
  describe('umbral ampliado cuando el vehiculo llevaba rato detenido', () => {
    // llena el historial: 90s reportando a 0 km/h, para que quede marcado como parado
    function parkFor90s(deviceId: string) {
      for (let i = 0; i < 9; i++) {
        service.recordPosition(deviceId, null, 0);
        vi.advanceTimersByTime(10000);
      }
      service.recordPosition(deviceId, null, 0);
    }

    it('parado: 10s de hueco ya NO alerta (antes si)', () => {
      parkFor90s('T1');
      vi.advanceTimersByTime(10000);
      service.checkAllDevices();
      expect(socketServer.broadcastToProjectExceptDevice).not.toHaveBeenCalled();
    });

    it('parado: a los 30s si alerta - no se silencia para siempre', () => {
      parkFor90s('T1');
      vi.advanceTimersByTime(30000);
      service.checkAllDevices();
      expect(socketServer.broadcastToProjectExceptDevice).toHaveBeenCalled();
    });

    it('en movimiento conserva el umbral corto de 5s', () => {
      parkFor90s('T1');
      service.recordPosition('T1', null, 40); // arranco de verdad
      vi.advanceTimersByTime(5000);
      service.checkAllDevices();
      expect(socketServer.broadcastToProjectExceptDevice).toHaveBeenCalled();
    });

    it('un vehiculo recien visto no cuenta como "parado hace rato"', () => {
      service.recordPosition('T1', null, 0);
      vi.advanceTimersByTime(5000);
      service.checkAllDevices();
      expect(socketServer.broadcastToProjectExceptDevice).toHaveBeenCalled();
    });
  });
});
