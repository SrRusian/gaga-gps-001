import { beforeEach, describe, expect, it, vi } from 'vitest';
import SpeedAlertService from '../../../../../../backend/src/services/alerts/SpeedAlertService';

type FindSpeedLimits = (deviceId: string) => Promise<{ deviceLimit: number | null; groupLimit: number | null }>;
type BroadcastToProject = (projectId: number | null, event: string, payload: unknown) => void;

const NO_LIMITS = { deviceLimit: null, groupLimit: null };

describe('SpeedAlertService', () => {
  let socketServer: { broadcastToProject: ReturnType<typeof vi.fn<BroadcastToProject>> };
  let findSpeedLimits: ReturnType<typeof vi.fn<FindSpeedLimits>>;
  let service: InstanceType<typeof SpeedAlertService>;

  beforeEach(() => {
    socketServer = { broadcastToProject: vi.fn<BroadcastToProject>() };
    findSpeedLimits = vi.fn<FindSpeedLimits>().mockResolvedValue(NO_LIMITS);
    service = new SpeedAlertService({ deviceRepo: { findSpeedLimits }, socketServer });
  });

  it('no emite nada si no hay ningun limite (geocerca, dispositivo ni grupo)', async () => {
    await service.evaluate({ deviceId: 'V1', speedKmh: 200, projectId: 7 });
    expect(socketServer.broadcastToProject).not.toHaveBeenCalled();
  });

  it('no emite nada por debajo del 90% del limite', async () => {
    findSpeedLimits.mockResolvedValue({ deviceLimit: 40, groupLimit: null });
    await service.evaluate({ deviceId: 'V1', speedKmh: 30, projectId: 7 });
    expect(socketServer.broadcastToProject).not.toHaveBeenCalled();
  });

  it('emite alert:warning (no critical) al llegar al 90% del limite', async () => {
    findSpeedLimits.mockResolvedValue({ deviceLimit: 40, groupLimit: null });
    await service.evaluate({ deviceId: 'V1', speedKmh: 36, projectId: 7 });

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      7,
      'alert:warning',
      expect.objectContaining({ type: 'speed_warning', deviceId: 'V1' }),
    );
    expect(socketServer.broadcastToProject).not.toHaveBeenCalledWith(7, 'alert:critical', expect.anything());
  });

  it('emite alert:critical al superar el limite', async () => {
    findSpeedLimits.mockResolvedValue({ deviceLimit: 40, groupLimit: null });
    await service.evaluate({ deviceId: 'V1', speedKmh: 45, projectId: 7 });

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      7,
      'alert:critical',
      expect.objectContaining({ type: 'speed_danger', loop: true }),
    );
  });

  it('gana el limite mas estricto entre geocerca, dispositivo y grupo', async () => {
    findSpeedLimits.mockResolvedValue({ deviceLimit: 60, groupLimit: 50 });
    // geocerca permite 40 - mas estricto que device (60) y group (50)
    await service.evaluate({
      deviceId: 'V1',
      speedKmh: 45,
      projectId: 7,
      geofenceMatches: [{ speed_limit_kmh: 40 }],
    });

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      7,
      'alert:critical',
      expect.objectContaining({ limitKmh: 40 }),
    );
  });

  it('ignora geocercas sin limite propio (speed_limit_kmh null)', async () => {
    findSpeedLimits.mockResolvedValue({ deviceLimit: 40, groupLimit: null });
    await service.evaluate({
      deviceId: 'V1',
      speedKmh: 45,
      projectId: 7,
      geofenceMatches: [{ speed_limit_kmh: null }],
    });

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      7,
      'alert:critical',
      expect.objectContaining({ limitKmh: 40 }),
    );
  });

  it('no re-emite mientras se mantiene en la misma severidad', async () => {
    findSpeedLimits.mockResolvedValue({ deviceLimit: 40, groupLimit: null });
    await service.evaluate({ deviceId: 'V1', speedKmh: 45, projectId: 7 });
    socketServer.broadcastToProject.mockClear();
    await service.evaluate({ deviceId: 'V1', speedKmh: 50, projectId: 7 });
    expect(socketServer.broadcastToProject).not.toHaveBeenCalled();
  });

  it('emite alert:clear al volver a velocidad segura', async () => {
    findSpeedLimits.mockResolvedValue({ deviceLimit: 40, groupLimit: null });
    await service.evaluate({ deviceId: 'V1', speedKmh: 45, projectId: 7 });
    socketServer.broadcastToProject.mockClear();
    await service.evaluate({ deviceId: 'V1', speedKmh: 20, projectId: 7 });

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      7,
      'alert:clear',
      expect.objectContaining({ deviceId: 'V1' }),
    );
  });

  it('getActiveAlerts refleja el estado actual por dispositivo', async () => {
    findSpeedLimits.mockResolvedValue({ deviceLimit: 40, groupLimit: null });
    await service.evaluate({ deviceId: 'V1', speedKmh: 45, projectId: 7 });
    expect(service.getActiveAlerts()).toEqual({ V1: 'danger' });
  });

  it('clearDevice limpia una alerta activa', async () => {
    findSpeedLimits.mockResolvedValue({ deviceLimit: 40, groupLimit: null });
    await service.evaluate({ deviceId: 'V1', speedKmh: 45, projectId: 9 });
    socketServer.broadcastToProject.mockClear();

    service.clearDevice('V1', 9);

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      9,
      'alert:clear',
      expect.objectContaining({ deviceId: 'V1' }),
    );
    expect(service.getActiveAlerts().V1).toBeUndefined();
  });

  it('_recordAlertEvent es fire-and-forget via alertEventRepo si se provee', async () => {
    const recordOrEscalate = vi.fn().mockResolvedValue(undefined);
    const withRepo = new SpeedAlertService({
      deviceRepo: { findSpeedLimits: vi.fn().mockResolvedValue({ deviceLimit: 40, groupLimit: null }) },
      socketServer,
      alertEventRepo: { recordOrEscalate, resolveOpen: vi.fn().mockResolvedValue(undefined) },
    });
    await withRepo.evaluate({ deviceId: 'V1', speedKmh: 45, projectId: 7 });

    expect(recordOrEscalate).toHaveBeenCalledWith(
      expect.objectContaining({ alertType: 'speed', severity: 'danger', deviceId: 'V1' }),
    );
  });

  it('no emite nada si socketServer todavia no se asigno', async () => {
    const withoutSocket = new SpeedAlertService({
      deviceRepo: { findSpeedLimits: vi.fn().mockResolvedValue({ deviceLimit: 40, groupLimit: null }) },
    });
    await expect(
      withoutSocket.evaluate({ deviceId: 'V1', speedKmh: 45, projectId: 7 }),
    ).resolves.not.toThrow();
  });
});
