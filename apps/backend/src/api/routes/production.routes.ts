import type { RequestHandler } from 'express';
import express from 'express';
import type EquipmentActivityRepository from '../../repositories/EquipmentActivityRepository';
import type PayRateRepository from '../../repositories/PayRateRepository';
import type ProductionRecordRepository from '../../repositories/ProductionRecordRepository';

// Estructura base (schema + CRUD) para el futuro sistema de control de producción -
// sin cálculo de ingreso/costo/pago todavía, eso requiere las fórmulas reales del negocio.

export interface ProductionRouterDeps {
  equipmentActivityRepo: EquipmentActivityRepository;
  productionRecordRepo: ProductionRecordRepository;
  payRateRepo: PayRateRepository;
  authMiddleware: RequestHandler;
  requireRole: (...roles: string[]) => RequestHandler;
}

export function buildProductionRouter({
  equipmentActivityRepo,
  productionRecordRepo,
  payRateRepo,
  authMiddleware,
  requireRole,
}: ProductionRouterDeps) {
  const router = express.Router();
  const canView = requireRole('admin', 'project_administrator', 'project_supervisor', 'project_manager');
  const canManage = requireRole('admin', 'project_administrator');

  router.use(authMiddleware);

  router.get('/activity/:deviceId', canView, async (req, res) => {
    try {
      const { from, to } = req.query;
      if (!from || !to) return res.status(400).json({ error: 'from y to son requeridos' });
      const rows = await equipmentActivityRepo.findByDevice(String(req.params.deviceId), String(from), String(to));
      res.json(rows);
    } catch (err) {
      console.error('production.routes GET /activity/:deviceId:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo actividad' });
    }
  });

  router.post('/activity', canManage, async (req, res) => {
    try {
      const { deviceId, operatorSessionId, activityType, notes } = req.body;
      if (!deviceId || !activityType) {
        return res.status(400).json({ error: 'deviceId y activityType son requeridos' });
      }
      const segment = await equipmentActivityRepo.create({ deviceId, operatorSessionId, activityType, notes });
      res.status(201).json(segment);
    } catch (err) {
      console.error('production.routes POST /activity:', (err as Error).message);
      res.status(500).json({ error: 'Error registrando actividad' });
    }
  });

  router.get('/records/:deviceId', canView, async (req, res) => {
    try {
      const { from, to } = req.query;
      if (!from || !to) return res.status(400).json({ error: 'from y to son requeridos' });
      const rows = await productionRecordRepo.findByDevice(String(req.params.deviceId), String(from), String(to));
      res.json(rows);
    } catch (err) {
      console.error('production.routes GET /records/:deviceId:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo producción' });
    }
  });

  router.post('/records', canManage, async (req, res) => {
    try {
      const { deviceId, shiftId, quantity, unit, metadata } = req.body;
      if (!deviceId || quantity === undefined || !unit) {
        return res.status(400).json({ error: 'deviceId, quantity y unit son requeridos' });
      }
      const projectId = req.user!.projectId ?? req.body.projectId ?? null;
      const record = await productionRecordRepo.create({
        deviceId,
        projectId,
        shiftId,
        quantity: Number(quantity),
        unit,
        recordedBy: req.user!.id,
        metadata,
      });
      res.status(201).json(record);
    } catch (err) {
      console.error('production.routes POST /records:', (err as Error).message);
      res.status(500).json({ error: 'Error registrando producción' });
    }
  });

  router.get('/pay-rates', canManage, async (req, res) => {
    try {
      const { from, to } = req.query;
      if (!from || !to) return res.status(400).json({ error: 'from y to son requeridos' });
      const rows = await payRateRepo.findByDateRange(String(from), String(to));
      res.json(rows);
    } catch (err) {
      console.error('production.routes GET /pay-rates:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo tarifas' });
    }
  });

  router.post('/pay-rates', canManage, async (req, res) => {
    try {
      const { deviceId, userId, rateType, rateAmount, currency } = req.body;
      if (!rateType || rateAmount === undefined) {
        return res.status(400).json({ error: 'rateType y rateAmount son requeridos' });
      }
      const projectId = req.user!.projectId ?? req.body.projectId ?? null;
      const rate = await payRateRepo.create({
        projectId,
        deviceId,
        userId,
        rateType,
        rateAmount: Number(rateAmount),
        currency,
        createdBy: req.user!.id,
      });
      res.status(201).json(rate);
    } catch (err) {
      console.error('production.routes POST /pay-rates:', (err as Error).message);
      res.status(500).json({ error: 'Error creando tarifa' });
    }
  });

  return router;
}

export default buildProductionRouter;
