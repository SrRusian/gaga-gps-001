export type ActivityType = 'productive' | 'unproductive' | 'maintenance';

// velocidad por debajo de esto se considera "detenido" - ya viene suavizada por SpeedEstimationService
// (zona muerta de 1km/h por defecto), un poco de margen extra evita falsos positivos por temblor de GPS
const STOPPED_SPEED_KMH = 2;
// pedido confirmado por el cliente: 5 minutos seguidos detenido = tiempo improductivo
const STOPPED_DURATION_MS = 5 * 60 * 1000;

interface ActiveSessionLike {
  id: number;
}

interface OperatorSessionRepoLike {
  findActiveByDevice(deviceId: string): Promise<ActiveSessionLike | null>;
}

interface EquipmentActivityRepoLike {
  create(segment: {
    deviceId: string;
    operatorSessionId?: number | null;
    activityType: ActivityType;
  }): Promise<unknown>;
  closeOpen(deviceId: string): Promise<void>;
}

interface DeviceState {
  belowThresholdSince: number | null;
  currentType: ActivityType | null;
}

interface EvaluateParams {
  deviceId: string;
  speedKmh: number;
  timestamp: number;
}

// clasifica productivo/improductivo automaticamente mientras hay un turno de operador activo -
// "mantenimiento" queda fuera a proposito, no hay señal automatica razonable para detectarlo
// (se registra a mano via POST /api/production/activity, ver production.routes.ts)
class ActivityClassificationService {
  operatorSessionRepo: OperatorSessionRepoLike;
  equipmentActivityRepo: EquipmentActivityRepoLike;
  deviceState: Record<string, DeviceState>;

  constructor({
    operatorSessionRepo,
    equipmentActivityRepo,
  }: {
    operatorSessionRepo: OperatorSessionRepoLike;
    equipmentActivityRepo: EquipmentActivityRepoLike;
  }) {
    this.operatorSessionRepo = operatorSessionRepo;
    this.equipmentActivityRepo = equipmentActivityRepo;
    this.deviceState = {};
  }

  async evaluate({ deviceId, speedKmh, timestamp }: EvaluateParams): Promise<void> {
    const session = await this.operatorSessionRepo.findActiveByDevice(deviceId);
    if (!session) {
      delete this.deviceState[deviceId];
      return;
    }

    const state = this.deviceState[deviceId] ?? { belowThresholdSince: null, currentType: null };
    this.deviceState[deviceId] = state;

    const isStopped = speedKmh < STOPPED_SPEED_KMH;

    if (isStopped) {
      if (state.belowThresholdSince == null) state.belowThresholdSince = timestamp;
      const elapsed = timestamp - state.belowThresholdSince;
      if (elapsed >= STOPPED_DURATION_MS && state.currentType !== 'unproductive') {
        await this.switchActivity(deviceId, session.id, 'unproductive');
        state.currentType = 'unproductive';
      }
    } else {
      state.belowThresholdSince = null;
      if (state.currentType !== 'productive') {
        await this.switchActivity(deviceId, session.id, 'productive');
        state.currentType = 'productive';
      }
    }
  }

  async switchActivity(deviceId: string, operatorSessionId: number, activityType: ActivityType): Promise<void> {
    try {
      await this.equipmentActivityRepo.closeOpen(deviceId);
      await this.equipmentActivityRepo.create({ deviceId, operatorSessionId, activityType });
    } catch (err) {
      console.error('ActivityClassificationService.switchActivity:', (err as Error).message);
    }
  }

  // turno cerrado - cierra el segmento abierto y olvida el estado en memoria del dispositivo
  endSession(deviceId: string): void {
    delete this.deviceState[deviceId];
    this.equipmentActivityRepo
      .closeOpen(deviceId)
      .catch((err: Error) => console.error('ActivityClassificationService.endSession:', err.message));
  }

  clearDevice(deviceId: string): void {
    delete this.deviceState[deviceId];
  }
}

export default ActivityClassificationService;
