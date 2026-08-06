// Test de caracterización — congela el comportamiento actual ANTES
// de convertir a TypeScript. RF-ALR-11: solo el supervisor desactiva,
// nunca automático.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PreventiveStopService from './PreventiveStopService';

describe('PreventiveStopService', () => {
  let io: { emit: ReturnType<typeof vi.fn> };
  let service: InstanceType<typeof PreventiveStopService>;

  beforeEach(() => {
    io = { emit: vi.fn() };
    service = new PreventiveStopService({ io });
  });

  it('arranca inactivo', () => {
    expect(service.getStatus()).toEqual({
      isActive: false,
      activatedAt: null,
      activatedBy: null,
      reason: null,
    });
  });

  it('activate() emite fleet:preventive_stop y supervisor:preventive_stop', () => {
    service.activate('Vehículo sin señal', 'auto');

    expect(service.isActive).toBe(true);
    expect(io.emit).toHaveBeenCalledWith(
      'fleet:preventive_stop',
      expect.objectContaining({
        active: true,
        reason: 'Vehículo sin señal',
        triggeredBy: 'auto',
        loop: true,
      }),
    );
    expect(io.emit).toHaveBeenCalledWith(
      'supervisor:preventive_stop',
      expect.objectContaining({ active: true, reason: 'Vehículo sin señal', triggeredBy: 'auto' }),
    );
  });

  it('activate() es un no-op si ya está activo (no reemite ni cambia la razón)', () => {
    service.activate('primera razón', 'auto');
    io.emit.mockClear();
    service.activate('segunda razón', 'supervisor');

    expect(io.emit).not.toHaveBeenCalled();
    expect(service.getStatus().reason).toBe('primera razón');
    expect(service.getStatus().activatedBy).toBe('auto');
  });

  it('deactivate() solo funciona si está activo, y limpia el estado', () => {
    service.deactivate('supervisor-1');
    expect(io.emit).not.toHaveBeenCalled();

    service.activate('razón', 'auto');
    io.emit.mockClear();
    service.deactivate('supervisor-1');

    expect(service.isActive).toBe(false);
    expect(service.getStatus()).toEqual({
      isActive: false,
      activatedAt: null,
      // activatedBy NO se limpia en deactivate() — solo activatedAt y reason.
      activatedBy: 'auto',
      reason: null,
    });
    expect(io.emit).toHaveBeenCalledWith(
      'fleet:preventive_stop_clear',
      expect.objectContaining({ active: false, deactivatedBy: 'supervisor-1' }),
    );
  });

  it('deactivate() usa "supervisor" como valor default si no se pasa quién desactiva', () => {
    service.activate('razón', 'auto');
    service.deactivate();
    expect(io.emit).toHaveBeenCalledWith(
      'supervisor:preventive_stop',
      expect.objectContaining({ active: false, deactivatedBy: 'supervisor' }),
    );
  });
});
