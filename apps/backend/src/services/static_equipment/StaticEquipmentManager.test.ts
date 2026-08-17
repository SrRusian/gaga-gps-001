// Test de caracterización - congela el comportamiento actual ANTES
// de convertir a TypeScript.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StaticEquipmentManager from './StaticEquipmentManager';

const LAT = 19.35;
const LON = -103.56;
const METERS_PER_DEG_LAT = 111320;

function north(meters: number) {
  return LAT + meters / METERS_PER_DEG_LAT;
}

function pos(deviceId: number, lat: number) {
  return { deviceId, latitude: lat, longitude: LON };
}

const equipment = {
  id: 1,
  projectId: 1,
  name: 'Pala 1',
  type: 'shovel',
  lat: LAT,
  lon: LON,
  swingRadius: 15,
  safetyRadius: 20,
  status: 'active_swing',
  linkedDeviceId: null,
} as const;

describe('StaticEquipmentManager', () => {
  let io: { emit: ReturnType<typeof vi.fn> };
  let manager: InstanceType<typeof StaticEquipmentManager>;

  beforeEach(() => {
    io = { emit: vi.fn() };
    manager = new StaticEquipmentManager({ io });
    manager.registerEquipment(equipment);
  });

  it('updateStatus cambia el estado en memoria y NO emite por socket', () => {
    // Ya no emite aquí a propósito - antes hacía io.emit(...) a TODOS
    // los clientes conectados sin importar su proyecto (fuga de
    // aislamiento). Notificar por socket ahora es responsabilidad del
    // caller (equipment.routes.ts / operator-sessions.routes.ts), que
    // sí conoce el projectId y usa broadcastToProject.
    manager.updateStatus(1, 'active_pause');
    expect(manager.equipment[1].status).toBe('active_pause');
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('updateStatus en un equipo inexistente no lanza ni emite', () => {
    expect(() => manager.updateStatus(999, 'inactive')).not.toThrow();
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('clearDeviceLink desvincula la tableta y devuelve el equipo afectado', () => {
    manager.registerEquipment({ ...equipment, linkedDeviceId: 'TABLETA-EQ' });
    const result = manager.clearDeviceLink('TABLETA-EQ');
    expect(result?.id).toBe(1);
    expect(manager.equipment[1].linkedDeviceId).toBeNull();
  });

  it('clearDeviceLink con una tableta no vinculada a nada devuelve null', () => {
    expect(manager.clearDeviceLink('TABLETA-NADA')).toBeNull();
  });

  it('clearEquipment libera al vehículo que seguía en zona de alerta (approach_clear) y borra el equipo', () => {
    manager.evaluate(pos(10, north(15))); // entra a "minimum"
    io.emit.mockClear();
    manager.clearEquipment(1);
    // deviceId llega como STRING aquí (a diferencia de otros emits de
    // esta clase) - clearEquipment lo reconstruye a partir de la
    // pairKey guardada (`${deviceId}-${equipmentId}`, siempre texto),
    // no tiene acceso al valor original de evaluate(). En producción
    // deviceId ya es siempre string (ids reales como "CAMION-01"),
    // así que no hay diferencia práctica - solo se nota acá porque el
    // fixture de este archivo usa deviceId numérico por brevedad.
    expect(io.emit).toHaveBeenCalledWith(
      'equipment:approach_clear',
      expect.objectContaining({ deviceId: '10', equipmentId: 1 }),
    );
    expect(manager.equipment[1]).toBeUndefined();
  });

  it('clearEquipment en un vehículo que ya estaba "clear" no emite approach_clear de más', () => {
    manager.evaluate(pos(11, north(1000))); // nunca entró a ninguna zona
    io.emit.mockClear();
    manager.clearEquipment(1);
    expect(io.emit).not.toHaveBeenCalledWith(
      'equipment:approach_clear',
      expect.objectContaining({ deviceId: 11 }),
    );
  });

  it('clearEquipment en un equipo inexistente no lanza ni emite', () => {
    expect(() => manager.clearEquipment(999)).not.toThrow();
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('evaluate se salta a sí mismo cuando el deviceId es la tableta vinculada del equipo', () => {
    manager.registerEquipment({ ...equipment, linkedDeviceId: 'TABLETA-EQ' });
    // Justo en el centro del equipo (distancia 0) - dispararía
    // minimum_limit para cualquier otro deviceId, pero este es SU
    // PROPIA tableta.
    manager.evaluate({ deviceId: 'TABLETA-EQ', latitude: LAT, longitude: LON });
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('ignora por completo equipos "inactive" (sin zonas ni alertas)', () => {
    manager.updateStatus(1, 'inactive');
    io.emit.mockClear();
    manager.evaluate(pos(10, north(5))); // dentro de cualquier zona posible
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('zona exterior (outer, 50m con status active_swing) dispara equipment:approach_outer', () => {
    // outerZone = 50 * 1.0 = 50m; innerZone = safetyRadius(20)*2 = 40m
    manager.evaluate(pos(10, north(45)));
    expect(io.emit).toHaveBeenCalledWith(
      'equipment:approach_outer',
      expect.objectContaining({ deviceId: 10, equipmentId: 1, distance: 45 }),
    );
  });

  it('zona interior dispara approach_inner + notifica al operador del equipo (vehicle_approaching)', () => {
    manager.evaluate(pos(10, north(30))); // <=40 innerZone, >20 minDistance
    expect(io.emit).toHaveBeenCalledWith(
      'equipment:approach_inner',
      expect.objectContaining({ deviceId: 10, distance: 30 }),
    );
    expect(io.emit).toHaveBeenCalledWith(
      'equipment:vehicle_approaching',
      expect.objectContaining({ deviceId: 10, equipmentId: 1 }),
    );
  });

  it('límite mínimo (<=safetyRadius) dispara equipment:minimum_limit con loop:true', () => {
    manager.evaluate(pos(10, north(15)));
    expect(io.emit).toHaveBeenCalledWith(
      'equipment:minimum_limit',
      expect.objectContaining({ deviceId: 10, distance: 15, loop: true }),
    );
  });

  it('en zona "outer" actualiza la distancia en vivo con equipment:distance_update en evaluaciones sucesivas', () => {
    manager.evaluate(pos(10, north(48))); // entra a outer
    io.emit.mockClear();
    manager.evaluate(pos(10, north(46))); // se sigue acercando, aún en outer
    expect(io.emit).toHaveBeenCalledWith(
      'equipment:distance_update',
      expect.objectContaining({ deviceId: 10, distance: 46 }),
    );
  });

  it('emite approach_clear al salir de todas las zonas tras haber estado dentro', () => {
    manager.evaluate(pos(10, north(30))); // entra a inner
    io.emit.mockClear();
    manager.evaluate(pos(10, north(1000))); // sale de todo
    expect(io.emit).toHaveBeenCalledWith(
      'equipment:approach_clear',
      expect.objectContaining({ deviceId: 10 }),
    );
  });

  it('active_pause reduce todos los umbrales al 60%', () => {
    manager.updateStatus(1, 'active_pause');
    io.emit.mockClear();
    // outerZone pasa de 50 a 30 - a 40m ya no debería disparar "outer"
    manager.evaluate(pos(10, north(40)));
    expect(io.emit).not.toHaveBeenCalledWith('equipment:approach_outer', expect.anything());

    // pero a 25m sí debe entrar en la zona exterior reducida (30m)
    io.emit.mockClear();
    manager.evaluate(pos(11, north(25)));
    expect(io.emit).toHaveBeenCalledWith(
      'equipment:approach_outer',
      expect.objectContaining({ deviceId: 11 }),
    );
  });

  it('registerEquipment sobrescribe si se registra el mismo id de nuevo', () => {
    manager.registerEquipment({ ...equipment, name: 'Pala Renombrada' });
    expect(manager.equipment[1].name).toBe('Pala Renombrada');
    expect(Object.keys(manager.equipment)).toHaveLength(1);
  });

  it('mantiene estado de aproximación independiente por par vehículo-equipo', () => {
    manager.evaluate(pos(10, north(15))); // V10 -> minimum
    manager.evaluate(pos(11, north(1000))); // V11 -> clear (nunca estuvo dentro, no emite)
    io.emit.mockClear();
    manager.evaluate(pos(10, north(15))); // V10 sigue en minimum -> no re-dispara
    expect(io.emit).not.toHaveBeenCalledWith('equipment:minimum_limit', expect.anything());
  });
});
