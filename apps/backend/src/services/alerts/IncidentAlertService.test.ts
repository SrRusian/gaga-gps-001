import { beforeEach, describe, expect, it, vi } from 'vitest';
import IncidentAlertService from './IncidentAlertService';
import type { IncidentReportRow } from '../../repositories/IncidentReportRepository';

const LAT = 19.35;
const LON = -103.56;
const METERS_PER_DEG_LAT = 111320;

function north(meters: number) {
  return LAT + meters / METERS_PER_DEG_LAT;
}

function makeIncident(overrides: Partial<IncidentReportRow> = {}): IncidentReportRow {
  return {
    id: 1,
    project_id: 1,
    device_id: 'CAMION-01',
    reported_by: 5,
    category: 'obstacle',
    message: 'Piedra grande',
    latitude: LAT,
    longitude: LON,
    radius_meters: 100,
    status: 'open',
    resolved_by: null,
    reported_at: new Date(),
    resolved_at: null,
    ...overrides,
  };
}

describe('IncidentAlertService', () => {
  let socketServer: { broadcastToProject: ReturnType<typeof vi.fn> };
  let incidentRepo: {
    create: ReturnType<typeof vi.fn>;
    resolve: ReturnType<typeof vi.fn>;
    findAllOpen: ReturnType<typeof vi.fn>;
  };
  let service: InstanceType<typeof IncidentAlertService>;

  beforeEach(() => {
    socketServer = { broadcastToProject: vi.fn() };
    incidentRepo = { create: vi.fn(), resolve: vi.fn(), findAllOpen: vi.fn() };
    service = new IncidentAlertService({
      socketServer,
      incidentRepo: incidentRepo as never,
    });
  });

  it('report() persiste, guarda en memoria, y emite incident:reported + supervisor:incident nivel 1', async () => {
    const incident = makeIncident();
    incidentRepo.create.mockResolvedValue(incident);

    const result = await service.report({
      projectId: 1,
      deviceId: 'CAMION-01',
      reportedBy: 5,
      category: 'obstacle',
      latitude: LAT,
      longitude: LON,
    });

    expect(result).toBe(incident);
    expect(service.activeIncidents[1]).toBe(incident);
    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      1,
      'incident:reported',
      expect.objectContaining({ id: 1, deviceId: 'CAMION-01', category: 'obstacle' }),
    );
    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      1,
      'supervisor:incident',
      expect.objectContaining({ id: 1, level: 1 }),
    );
  });

  it('evaluate() alerta una sola vez a un vehículo que entra al radio, no en cada fix', () => {
    service.activeIncidents[1] = makeIncident();

    service.evaluate({ deviceId: 'CAMION-02', latitude: north(50), longitude: LON, projectId: 1 });
    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      1,
      'incident:nearby',
      expect.objectContaining({ deviceId: 'CAMION-02', incidentId: 1 }),
    );

    socketServer.broadcastToProject.mockClear();
    service.evaluate({ deviceId: 'CAMION-02', latitude: north(45), longitude: LON, projectId: 1 });
    expect(socketServer.broadcastToProject).not.toHaveBeenCalled();
  });

  it('evaluate() no alerta si la posición está fuera del radio del incidente', () => {
    service.activeIncidents[1] = makeIncident({ radius_meters: 100 });
    service.evaluate({ deviceId: 'CAMION-02', latitude: north(500), longitude: LON, projectId: 1 });
    expect(socketServer.broadcastToProject).not.toHaveBeenCalled();
  });

  it('evaluate() nunca alerta al propio dispositivo que reportó el incidente', () => {
    service.activeIncidents[1] = makeIncident({ device_id: 'CAMION-01' });
    service.evaluate({ deviceId: 'CAMION-01', latitude: LAT, longitude: LON, projectId: 1 });
    expect(socketServer.broadcastToProject).not.toHaveBeenCalled();
  });

  it('evaluate() ignora incidentes de otro proyecto - aislamiento nativo, sin rastreo aparte', () => {
    service.activeIncidents[1] = makeIncident({ project_id: 1 });
    service.evaluate({ deviceId: 'CAMION-02', latitude: north(10), longitude: LON, projectId: 2 });
    expect(socketServer.broadcastToProject).not.toHaveBeenCalled();
  });

  it('vuelve a alertar si el vehículo sale del radio y vuelve a entrar', () => {
    service.activeIncidents[1] = makeIncident();

    service.evaluate({ deviceId: 'CAMION-02', latitude: north(50), longitude: LON, projectId: 1 });
    service.evaluate({ deviceId: 'CAMION-02', latitude: north(500), longitude: LON, projectId: 1 }); // sale
    socketServer.broadcastToProject.mockClear();

    service.evaluate({ deviceId: 'CAMION-02', latitude: north(50), longitude: LON, projectId: 1 }); // vuelve a entrar
    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      1,
      'incident:nearby',
      expect.objectContaining({ deviceId: 'CAMION-02' }),
    );
  });

  it('resolve() actualiza estado, limpia memoria, y emite incident:resolved + supervisor:incident nivel 0', async () => {
    const incident = makeIncident();
    service.activeIncidents[1] = incident;
    incidentRepo.resolve.mockResolvedValue({ ...incident, status: 'resolved' });

    const result = await service.resolve(1, 9);

    expect(result?.status).toBe('resolved');
    expect(service.activeIncidents[1]).toBeUndefined();
    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(1, 'incident:resolved', { id: 1 });
    expect(socketServer.broadcastToProject).toHaveBeenCalledWith(
      1,
      'supervisor:incident',
      expect.objectContaining({ id: 1, level: 0 }),
    );
  });

  it('resolve() devuelve null si el incidente ya no está abierto (repo no encuentra fila que actualizar)', async () => {
    incidentRepo.resolve.mockResolvedValue(null);
    const result = await service.resolve(999, 9);
    expect(result).toBeNull();
    expect(socketServer.broadcastToProject).not.toHaveBeenCalled();
  });
});
