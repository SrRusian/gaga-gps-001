/**
 * PreventiveStopService.js
 *
 * Responsabilidad: Protocolo de parada preventiva colectiva.
 * Puede activarse automáticamente por condiciones críticas
 * o manualmente por el supervisor.
 *
 * Solo el supervisor puede desactivarlo — nunca automático.
 *
 * RF asociados: RF-ALR-11
 */

class PreventiveStopService {

  constructor({ io }) {
    this.io = io;
    this.isActive = false;
    this.activatedAt = null;
    this.activatedBy = null; // 'auto' | 'supervisor'
    this.activationReason = null;
  }

  /**
   * Activa el protocolo de parada preventiva colectiva
   * Emite alerta a TODOS los dispositivos simultáneamente
   */
  activate(reason, triggeredBy = 'auto') {
    if (this.isActive) return; // Ya está activo

    this.isActive = true;
    this.activatedAt = new Date().toISOString();
    this.activatedBy = triggeredBy;
    this.activationReason = reason;

    console.log(`🛑 PARADA PREVENTIVA COLECTIVA ACTIVADA`);
    console.log(`   Razón: ${reason}`);
    console.log(`   Activado por: ${triggeredBy}`);

    // Emitir a TODA la flota simultáneamente
    this.io.emit('fleet:preventive_stop', {
      active: true,
      reason,
      triggeredBy,
      message: 'ALTO TOTAL — DETENGA EL VEHÍCULO INMEDIATAMENTE Y REPORTE A CENTRAL POR RADIO',
      loop: true,
      activatedAt: this.activatedAt,
      timestamp: new Date().toISOString()
    });

    // Notificar al supervisor
    this.io.emit('supervisor:preventive_stop', {
      active: true,
      reason,
      triggeredBy,
      activatedAt: this.activatedAt,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Desactiva el protocolo — SOLO puede hacerlo el supervisor
   * RF-ALR-11: no se desactiva automáticamente bajo ninguna circunstancia
   */
  deactivate(supervisorId = 'supervisor') {
    if (!this.isActive) return;

    console.log(`✅ PARADA PREVENTIVA DESACTIVADA por ${supervisorId}`);

    this.isActive = false;
    this.activatedAt = null;
    this.activationReason = null;

    // Notificar cancelación a toda la flota
    this.io.emit('fleet:preventive_stop_clear', {
      active: false,
      deactivatedBy: supervisorId,
      message: 'ALERTA CANCELADA POR CENTRAL — CONFIRME POSICIÓN Y ESPERE AUTORIZACIÓN PARA CONTINUAR',
      timestamp: new Date().toISOString()
    });

    this.io.emit('supervisor:preventive_stop', {
      active: false,
      deactivatedBy: supervisorId,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Retorna el estado actual del protocolo
   */
  getStatus() {
    return {
      isActive: this.isActive,
      activatedAt: this.activatedAt,
      activatedBy: this.activatedBy,
      reason: this.activationReason
    };
  }
}

module.exports = PreventiveStopService;