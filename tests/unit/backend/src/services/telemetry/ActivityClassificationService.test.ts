import { beforeEach, describe, expect, it, vi } from 'vitest';
import ActivityClassificationService, {
  type ActivityType,
} from '../../../../../../backend/src/services/telemetry/ActivityClassificationService';

const SESSION = { id: 42 };
const FIVE_MIN_MS = 5 * 60 * 1000;
const T0 = 1_700_000_000_000;

type FindActiveByDevice = (deviceId: string) => Promise<{ id: number } | null>;
type CreateSegment = (segment: {
  deviceId: string;
  operatorSessionId?: number | null;
  activityType: ActivityType;
}) => Promise<unknown>;
type CloseOpen = (deviceId: string) => Promise<void>;

describe('ActivityClassificationService', () => {
  let findActiveByDevice: ReturnType<typeof vi.fn<FindActiveByDevice>>;
  let create: ReturnType<typeof vi.fn<CreateSegment>>;
  let closeOpen: ReturnType<typeof vi.fn<CloseOpen>>;
  let service: InstanceType<typeof ActivityClassificationService>;

  beforeEach(() => {
    findActiveByDevice = vi.fn().mockResolvedValue(SESSION);
    create = vi.fn().mockResolvedValue(undefined);
    closeOpen = vi.fn().mockResolvedValue(undefined);
    service = new ActivityClassificationService({
      operatorSessionRepo: { findActiveByDevice },
      equipmentActivityRepo: { create, closeOpen },
    });
  });

  async function flush() {
    // switchActivity encadena closeOpen().then(create(...)) sin await en evaluate() -
    // deja correr la microtask queue antes de aserciones
    await Promise.resolve();
    await Promise.resolve();
  }

  it('no clasifica nada sin un turno de operador activo', async () => {
    findActiveByDevice.mockResolvedValue(null);
    await service.evaluate({ deviceId: 'V1', speedKmh: 30, timestamp: T0 });
    await flush();
    expect(create).not.toHaveBeenCalled();
  });

  it('abre un segmento "productive" en el primer movimiento con turno activo', async () => {
    await service.evaluate({ deviceId: 'V1', speedKmh: 30, timestamp: T0 });
    await flush();
    expect(create).toHaveBeenCalledWith({ deviceId: 'V1', operatorSessionId: 42, activityType: 'productive' });
  });

  it('no cambia de actividad mientras se mantiene detenido por menos de 5 minutos', async () => {
    await service.evaluate({ deviceId: 'V1', speedKmh: 30, timestamp: T0 });
    await flush();
    create.mockClear();

    await service.evaluate({ deviceId: 'V1', speedKmh: 0, timestamp: T0 + 1000 });
    await service.evaluate({ deviceId: 'V1', speedKmh: 0, timestamp: T0 + FIVE_MIN_MS - 1000 });
    await flush();
    expect(create).not.toHaveBeenCalled();
  });

  it('cambia a "unproductive" tras 5 minutos seguidos detenido', async () => {
    await service.evaluate({ deviceId: 'V1', speedKmh: 30, timestamp: T0 });
    await flush();
    create.mockClear();

    await service.evaluate({ deviceId: 'V1', speedKmh: 0, timestamp: T0 + 1000 });
    await service.evaluate({ deviceId: 'V1', speedKmh: 0, timestamp: T0 + 1000 + FIVE_MIN_MS + 1 });
    await flush();

    expect(closeOpen).toHaveBeenCalledWith('V1');
    expect(create).toHaveBeenCalledWith({ deviceId: 'V1', operatorSessionId: 42, activityType: 'unproductive' });
  });

  it('vuelve a "productive" en cuanto retoma movimiento', async () => {
    await service.evaluate({ deviceId: 'V1', speedKmh: 0, timestamp: T0 });
    await service.evaluate({ deviceId: 'V1', speedKmh: 0, timestamp: T0 + FIVE_MIN_MS + 1 });
    await flush();
    create.mockClear();

    await service.evaluate({ deviceId: 'V1', speedKmh: 25, timestamp: T0 + FIVE_MIN_MS + 2000 });
    await flush();
    expect(create).toHaveBeenCalledWith({ deviceId: 'V1', operatorSessionId: 42, activityType: 'productive' });
  });

  it('no re-emite la misma actividad en cada tick', async () => {
    await service.evaluate({ deviceId: 'V1', speedKmh: 30, timestamp: T0 });
    await flush();
    create.mockClear();

    await service.evaluate({ deviceId: 'V1', speedKmh: 32, timestamp: T0 + 1000 });
    await flush();
    expect(create).not.toHaveBeenCalled();
  });

  it('endSession cierra el segmento abierto y olvida el estado del dispositivo', async () => {
    await service.evaluate({ deviceId: 'V1', speedKmh: 30, timestamp: T0 });
    await flush();

    service.endSession('V1');
    await flush();
    expect(closeOpen).toHaveBeenCalledWith('V1');
    expect(service.deviceState.V1).toBeUndefined();
  });

  it('clearDevice olvida el estado sin cerrar nada en la base de datos', () => {
    service.deviceState.V1 = { belowThresholdSince: null, currentType: 'productive' };
    service.clearDevice('V1');
    expect(service.deviceState.V1).toBeUndefined();
    expect(closeOpen).not.toHaveBeenCalled();
  });
});
