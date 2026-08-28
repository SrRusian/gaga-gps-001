import type { RequestHandler } from 'express';
import express from 'express';
import { env } from '../../config';
import type AlertEventRepository from '../../repositories/AlertEventRepository';
import type DeviceRepository from '../../repositories/DeviceRepository';
import type EquipmentVariableRepository from '../../repositories/EquipmentVariableRepository';
import { isValidSharedSecret } from '../../utils/sharedSecret';

export interface EquipmentVariablesRouterDeps {
  equipmentVariableRepo: EquipmentVariableRepository;
  deviceRepo: DeviceRepository;
  alertEventRepo?: AlertEventRepository;
  authMiddleware: RequestHandler;
  requireRole: (...roles: string[]) => RequestHandler;
}

export function buildEquipmentVariablesRouter({
  equipmentVariableRepo,
  deviceRepo,
  alertEventRepo,
  authMiddleware,
  requireRole,
}: EquipmentVariablesRouterDeps) {
  const router = express.Router();
  const canView = requireRole('admin', 'project_administrator', 'project_supervisor', 'project_manager');
  const canManage = requireRole('admin', 'project_administrator');

  // clave compartida, no JWT - la fuente real es previsiblemente una pasarela de hardware
  // del equipo, no un navegador con sesión (mismo criterio que /gps)
  router.post('/', async (req, res) => {
    try {
      const { deviceId, variableKey, value, unit, key } = req.body;

      if (env.telemetrySharedSecret && !isValidSharedSecret(env.telemetrySharedSecret, key)) {
        return res.status(401).json({ error: 'Clave inválida' });
      }
      if (!deviceId || !variableKey || value === undefined) {
        return res.status(400).json({ error: 'deviceId, variableKey y value son requeridos' });
      }

      const numericValue = Number(value);
      if (Number.isNaN(numericValue)) {
        return res.status(400).json({ error: 'value debe ser numérico' });
      }

      await equipmentVariableRepo.saveReading({
        deviceId: String(deviceId),
        variableKey: String(variableKey),
        value: numericValue,
        unit,
      });

      const threshold = await equipmentVariableRepo.getThreshold(String(deviceId), String(variableKey));
      const outOfRange =
        !!threshold &&
        ((threshold.min_safe !== null && numericValue < threshold.min_safe) ||
          (threshold.max_safe !== null && numericValue > threshold.max_safe));

      if (alertEventRepo) {
        if (outOfRange) {
          await alertEventRepo.recordOrEscalate({
            alertType: 'equipment_variable',
            severity: 'danger',
            deviceId: String(deviceId),
            deviceId2: String(variableKey),
            message: `${variableKey} fuera de rango: ${numericValue}${unit ?? ''}`,
            metadata: { variableKey, value: numericValue, minSafe: threshold?.min_safe, maxSafe: threshold?.max_safe },
          });
        } else {
          await alertEventRepo.resolveOpen({
            alertType: 'equipment_variable',
            deviceId: String(deviceId),
            deviceId2: String(variableKey),
          });
        }
      }

      res.status(201).json({ success: true, outOfRange });
    } catch (err) {
      console.error('equipment-variables.routes POST /:', (err as Error).message);
      res.status(500).json({ error: 'Error guardando lectura' });
    }
  });

  router.get('/:deviceId/history', authMiddleware, canView, async (req, res) => {
    try {
      const deviceId = String(req.params.deviceId);
      const device = await deviceRepo.findByUniqueId(deviceId);
      if (!device) return res.status(404).json({ error: 'Dispositivo no encontrado' });
      if (req.user!.projectId != null && device.project_id !== req.user!.projectId) {
        return res.status(404).json({ error: 'Dispositivo no encontrado' });
      }

      const { variableKey, from, to } = req.query;
      if (!variableKey || !from || !to) {
        return res.status(400).json({ error: 'variableKey, from y to son requeridos' });
      }

      const rows = await equipmentVariableRepo.findHistory({
        deviceId,
        variableKey: String(variableKey),
        from: String(from),
        to: String(to),
      });
      res.json(rows);
    } catch (err) {
      console.error('equipment-variables.routes GET /:deviceId/history:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo historial' });
    }
  });

  router.get('/:deviceId/thresholds/:variableKey', authMiddleware, canManage, async (req, res) => {
    try {
      const threshold = await equipmentVariableRepo.getThreshold(
        String(req.params.deviceId),
        String(req.params.variableKey),
      );
      res.json(threshold);
    } catch (err) {
      console.error('equipment-variables.routes GET /:deviceId/thresholds/:variableKey:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo umbral' });
    }
  });

  router.put('/:deviceId/thresholds/:variableKey', authMiddleware, canManage, async (req, res) => {
    try {
      const { minSafe, maxSafe, unit } = req.body;
      const threshold = await equipmentVariableRepo.setThreshold({
        deviceId: String(req.params.deviceId),
        variableKey: String(req.params.variableKey),
        minSafe: minSafe ?? null,
        maxSafe: maxSafe ?? null,
        unit,
        updatedBy: req.user!.id,
      });
      res.json(threshold);
    } catch (err) {
      console.error('equipment-variables.routes PUT /:deviceId/thresholds/:variableKey:', (err as Error).message);
      res.status(500).json({ error: 'Error configurando umbral' });
    }
  });

  return router;
}

export default buildEquipmentVariablesRouter;
