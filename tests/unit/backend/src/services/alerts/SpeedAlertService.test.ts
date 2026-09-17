import { beforeEach, describe, expect, it, vi } from 'vitest';
import SpeedAlertService from '../../../../../../backend/src/services/alerts/SpeedAlertService';

type FindAlertContext = (
  deviceId: string,
) => Promise<{ deviceLimit: number | null; groupLimit: number | null; vehicleTypeLimit: number | null }>;
type BroadcastToProject = (projectId: number | null, event: string, payload: unknown) => void;

const NO_LIMITS = { deviceLimit: null, groupLimit: null, vehicleTypeLimit: null };

describe('SpeedAlertService', () => {
  let socketServer: { broadcastToProject: ReturnType<typeof vi.fn<BroadcastToProject>> };
  let findAlertContext: ReturnType<typeof vi.fn<FindAlertContext>>;
  let service: InstanceType<typeof SpeedAlertService>;

  beforeEach(() => {
    socketServer = { broadcastToProject: vi.fn<BroadcastToProject>() };
    findAlertContext = vi.fn<FindAlertContext>().mockResolvedValue(NO_LIMITS);
    service = new SpeedAlertService({ deviceRepo: { findAlertContext }, socketServer });
  });

  it('no emite nada si no hay ningun limite (geocerca, dispositivo ni grupo)', async () => {
    await service.evaluate({ deviceId: 'V1', speedKmh: 200, projectId: 7 });
    expect(socketServer.broadcastToProject).not.toHaveBeenCalled();
  });

  it('no emite nada por debajo del 90% del limite', async () => {
    findAlertContext.mockResolvedValue({ deviceLimit: 40, groupLimit: null, vehicleTypeLimit: null });
    await service.evaluate({ deviceId: 'V1', speedKmh: 30, projectId: 7 });
    expect(socketServer.broadcastToProject).not.toHaveBeenCalled();
  });

  it('emite alert:warning (no critical) al llegar al 90% del limite', async () => {
    findAlertContext.mockResolvedValue({ deviceLimit: 40, groupLimit: null, vehicleTypeLimit: null });
    await service.evaluate({ deviceId: 'V1', speedKmh: 36, projectId: 7 });

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      7,
      'alert:warning',
      expect.objectContaining({ type: 'speed_warning', deviceId: 'V1' }),
    );
    expect(socketServer.broadcastToProject).not.toHaveBeenCalledWith(7, 'alert:critical', expect.anything());
  });

  it('emite alert:critical al superar el limite', async () => {
    findAlertContext.mockResolvedValue({ deviceLimit: 40, groupLimit: null, vehicleTypeLimit: null });
    await service.evaluate({ deviceId: 'V1', speedKmh: 45, projectId: 7 });

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      7,
      'alert:critical',
      expect.objectContaining({ type: 'speed_danger', loop: true }),
    );
  });

  it('gana el limite mas estricto entre geocerca, dispositivo, grupo y tipo de vehiculo', async () => {
    findAlertContext.mockResolvedValue({ deviceLimit: 60, groupLimit: 50, vehicleTypeLimit: 55 });
    // geocerca permite 40 - mas estricto que device (60), group (50) y vehicleType (55)
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

  it('el limite del tipo de vehiculo participa aunque no haya limite de dispositivo/grupo', async () => {
    findAlertContext.mockResolvedValue({ deviceLimit: null, groupLimit: null, vehicleTypeLimit: 40 });
    await service.evaluate({ deviceId: 'V1', speedKmh: 45, projectId: 7 });

    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      7,
      'alert:critical',
      expect.objectContaining({ limitKmh: 40 }),
    );
  });

  it('ignora geocercas sin limite propio (speed_limit_kmh null)', async () => {
    findAlertContext.mockResolvedValue({ deviceLimit: 40, groupLimit: null, vehicleTypeLimit: null });
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
    findAlertContext.mockResolvedValue({ deviceLimit: 40, groupLimit: null, vehicleTypeLimit: null });
    await service.evaluate({ deviceId: 'V1', speedKmh: 45, projectId: 7 });
    socketServer.broadcastToProject.mockClear();
    await service.evaluate({ deviceId: 'V1', speedKmh: 50, projectId: 7 });
    expect(socketServer.broadcastToProject).not.toHaveBeenCalled();
  });

  it('emite alert:clear al volver a velocidad segura', async () => {
    findAlertContext.mockResolvedValue({ deviceLimit: 40, groupLimit: null, vehicleTypeLimit: null });
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
    findAlertContext.mockResolvedValue({ deviceLimit: 40, groupLimit: null, vehicleTypeLimit: null });
    await service.evaluate({ deviceId: 'V1', speedKmh: 45, projectId: 7 });
    expect(service.getActiveAlerts()).toEqual({ V1: 'danger' });
  });

  it('clearDevice limpia una alerta activa', async () => {
    findAlertContext.mockResolvedValue({ deviceLimit: 40, groupLimit: null, vehicleTypeLimit: null });
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

  it('_recordAlertEvent es fire-and-forget via alertEventRepo si se provee, solo para "danger"', async () => {
    const recordOrEscalate = vi.fn().mockResolvedValue(undefined);
    const withRepo = new SpeedAlertService({
      deviceRepo: {
        findAlertContext: vi.fn().mockResolvedValue({ deviceLimit: 40, groupLimit: null, vehicleTypeLimit: null }),
      },
      socketServer,
      alertEventRepo: { recordOrEscalate, resolveOpen: vi.fn().mockResolvedValue(undefined) },
    });
    await withRepo.evaluate({ deviceId: 'V1', speedKmh: 45, projectId: 7 });

    expect(recordOrEscalate).toHaveBeenCalledWith(
      expect.objectContaining({ alertType: 'speed', severity: 'danger', deviceId: 'V1' }),
    );
  });

  it('el aviso temprano (90-99%, "warning") NO se registra en alertEventRepo - solo el operador lo ve', async () => {
    const recordOrEscalate = vi.fn().mockResolvedValue(undefined);
    const withRepo = new SpeedAlertService({
      deviceRepo: {
        findAlertContext: vi.fn().mockResolvedValue({ deviceLimit: 40, groupLimit: null, vehicleTypeLimit: null }),
      },
      socketServer,
      alertEventRepo: { recordOrEscalate, resolveOpen: vi.fn().mockResolvedValue(undefined) },
    });
    await withRepo.evaluate({ deviceId: 'V1', speedKmh: 36, projectId: 7 });

    expect(recordOrEscalate).not.toHaveBeenCalled();
  });

  it('crea una infraccion real al cruzar el limite (100%+), con lat/lon de la posicion', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const withRepo = new SpeedAlertService({
      deviceRepo: {
        findAlertContext: vi.fn().mockResolvedValue({ deviceLimit: 40, groupLimit: null, vehicleTypeLimit: null }),
      },
      socketServer,
      infractionRepo: { create },
    });
    await withRepo.evaluate({ deviceId: 'V1', speedKmh: 45, projectId: 7, latitude: 19.1, longitude: -103.2 });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'V1',
        projectId: 7,
        infractionType: 'speed',
        latitude: 19.1,
        longitude: -103.2,
      }),
    );
  });

  it('no crea infraccion para el aviso temprano (90-99%, "warning")', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const withRepo = new SpeedAlertService({
      deviceRepo: {
        findAlertContext: vi.fn().mockResolvedValue({ deviceLimit: 40, groupLimit: null, vehicleTypeLimit: null }),
      },
      socketServer,
      infractionRepo: { create },
    });
    await withRepo.evaluate({ deviceId: 'V1', speedKmh: 36, projectId: 7, latitude: 19.1, longitude: -103.2 });

    expect(create).not.toHaveBeenCalled();
  });

  it('no emite nada si socketServer todavia no se asigno', async () => {
    const withoutSocket = new SpeedAlertService({
      deviceRepo: {
        findAlertContext: vi.fn().mockResolvedValue({ deviceLimit: 40, groupLimit: null, vehicleTypeLimit: null }),
      },
    });
    await expect(
      withoutSocket.evaluate({ deviceId: 'V1', speedKmh: 45, projectId: 7 }),
    ).resolves.not.toThrow();
  });
});
