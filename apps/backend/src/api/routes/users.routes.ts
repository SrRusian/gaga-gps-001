/**
 * users.routes.ts
 *
 * CRUD de usuarios (operadores, supervisores, admins) para el
 * panel /admin. Solo accesible por rol 'admin' (ver auth.middleware).
 */
import bcrypt from 'bcryptjs';
import express from 'express';
import UserRepository, { UserHasSessionsError } from '../../repositories/UserRepository';

export function buildUsersRouter({ userRepo }: { userRepo: UserRepository }) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const users = await userRepo.findAll();
      res.json(users);
    } catch (err) {
      console.error('❌ users.routes GET /:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo usuarios' });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { email, password, name, role } = req.body;
      if (!email || !password || !name) {
        return res.status(400).json({ error: 'email, password y name son requeridos' });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      const user = await userRepo.create({ email, passwordHash, name, role });
      res.status(201).json(user);
    } catch (err) {
      console.error('❌ users.routes POST /:', (err as Error).message);
      res.status(500).json({ error: 'Error creando usuario' });
    }
  });

  router.patch('/:id', async (req, res) => {
    try {
      const { name, role, active } = req.body;
      const user = await userRepo.update(Number(req.params.id), { name, role, active });
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
      res.json(user);
    } catch (err) {
      console.error('❌ users.routes PATCH /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error actualizando usuario' });
    }
  });

  router.post('/:id/password', async (req, res) => {
    try {
      const { password } = req.body;
      if (!password) return res.status(400).json({ error: 'password requerido' });
      const passwordHash = await bcrypt.hash(password, 10);
      await userRepo.updatePassword(Number(req.params.id), passwordHash);
      res.json({ success: true });
    } catch (err) {
      console.error('❌ users.routes POST /:id/password:', (err as Error).message);
      res.status(500).json({ error: 'Error actualizando contraseña' });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      // ?force=true purga también sus turnos de operador registrados
      // — acción destructiva explícita, no es el comportamiento por
      // defecto (se recomienda desactivar para conservar el historial).
      const force = req.query.force === 'true';
      await userRepo.delete(Number(req.params.id), { force });
      res.json({ success: true });
    } catch (err) {
      if (err instanceof UserHasSessionsError) {
        return res.status(409).json({
          error:
            'El usuario tiene turnos de operador registrados — considere desactivarlo en vez de eliminarlo',
          code: err.code,
          hint: 'Reintente con ?force=true si desea eliminar también su historial de turnos',
        });
      }
      console.error('❌ users.routes DELETE /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error eliminando usuario' });
    }
  });

  return router;
}

export default buildUsersRouter;
