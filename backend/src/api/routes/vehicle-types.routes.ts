import type { RequestHandler } from 'express';
import express from 'express';
import type VehicleTypeRepository from '../../repositories/VehicleTypeRepository';
import type { UserRole } from '../../repositories/UserRepository';

export interface VehicleTypesRouterDeps {
  vehicleTypeRepo: VehicleTypeRepository;
  authMiddleware: RequestHandler;
  requireRole: (...roles: UserRole[]) => RequestHandler;
}

// catalogo global - cualquier rol autenticado puede leerlo (lo necesita para dibujar la silueta
// real del vehiculo en su mapa), solo admin (global) crea/edita/elimina tipos
export function buildVehicleTypesRouter({ vehicleTypeRepo, authMiddleware, requireRole }: VehicleTypesRouterDeps) {
  const router = express.Router();
  const canManage = requireRole('admin');

  router.get('/', authMiddleware, async (_req, res) => {
    try {
      res.json(await vehicleTypeRepo.findAll());
    } catch (err) {
      console.error('vehicle-types.routes GET /:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo tipos de vehículo' });
    }
  });

  router.post('/', authMiddleware, canManage, async (req, res) => {
    try {
      const { name, lengthMeters, widthMeters, maxSpeedKmh, category } = req.body;
      if (!name || !lengthMeters || !widthMeters) {
        return res.status(400).json({ error: 'name, lengthMeters y widthMeters son requeridos' });
      }
      if (lengthMeters <= 0 || widthMeters <= 0) {
        return res.status(400).json({ error: 'lengthMeters y widthMeters deben ser mayores a 0' });
      }
      if (maxSpeedKmh != null && maxSpeedKmh <= 0) {
        return res.status(400).json({ error: 'maxSpeedKmh debe ser mayor a 0' });
      }
      if (category != null && category !== 'transport' && category !== 'machinery') {
        return res.status(400).json({ error: "category debe ser 'transport' o 'machinery'" });
      }
      const vehicleType = await vehicleTypeRepo.create({
        name,
        lengthMeters,
        widthMeters,
        maxSpeedKmh: maxSpeedKmh ?? null,
        category: category ?? 'transport',
      });
      res.status(201).json(vehicleType);
    } catch (err) {
      console.error('vehicle-types.routes POST /:', (err as Error).message);
      res.status(500).json({ error: 'Error creando tipo de vehículo' });
    }
  });

  router.patch('/:id', authMiddleware, canManage, async (req, res) => {
    try {
      const { name, lengthMeters, widthMeters, maxSpeedKmh, category } = req.body;
      if (lengthMeters !== undefined && lengthMeters <= 0) {
        return res.status(400).json({ error: 'lengthMeters debe ser mayor a 0' });
      }
      if (widthMeters !== undefined && widthMeters <= 0) {
        return res.status(400).json({ error: 'widthMeters debe ser mayor a 0' });
      }
      if (maxSpeedKmh != null && maxSpeedKmh <= 0) {
        return res.status(400).json({ error: 'maxSpeedKmh debe ser mayor a 0' });
      }
      if (category != null && category !== 'transport' && category !== 'machinery') {
        return res.status(400).json({ error: "category debe ser 'transport' o 'machinery'" });
      }
      const vehicleType = await vehicleTypeRepo.update(Number(req.params.id), {
        name,
        lengthMeters,
        widthMeters,
        maxSpeedKmh,
        category,
      });
      if (!vehicleType) return res.status(404).json({ error: 'Tipo de vehículo no encontrado' });
      res.json(vehicleType);
    } catch (err) {
      console.error('vehicle-types.routes PATCH /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error actualizando tipo de vehículo' });
    }
  });

  router.delete('/:id', authMiddleware, canManage, async (req, res) => {
    try {
      await vehicleTypeRepo.delete(Number(req.params.id));
      res.json({ success: true });
    } catch (err) {
      console.error('vehicle-types.routes DELETE /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error eliminando tipo de vehículo' });
    }
  });

  return router;
}

export default buildVehicleTypesRouter;
