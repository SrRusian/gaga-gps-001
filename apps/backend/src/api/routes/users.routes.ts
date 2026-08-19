import bcrypt from 'bcryptjs';
import express from 'express';
import UserRepository, {
  EmailAlreadyExistsError,
  UserHasSessionsError,
} from '../../repositories/UserRepository';
import type { UserRow, UserRole } from '../../repositories/UserRepository';

export interface UsersRouterDeps {
  userRepo: UserRepository;
  requireRole: (...roles: UserRole[]) => import('express').RequestHandler;
}

export function buildUsersRouter({ userRepo, requireRole }: UsersRouterDeps) {
  const router = express.Router();
  const canManage = requireRole('admin', 'project_manager');

  async function wouldRemoveLastActiveAdmin(existing: UserRow): Promise<boolean> {
    if (existing.role !== 'admin' || !existing.active) return false;
    const remaining = await userRepo.countActiveAdmins(existing.id);
    return remaining === 0;
  }

  router.get('/', canManage, async (req, res) => {
    try {
      const users =
        req.user!.projectId != null
          ? await userRepo.findByProject(req.user!.projectId)
          : await userRepo.findAll();
      res.json(users);
    } catch (err) {
      console.error('users.routes GET /:', (err as Error).message);
      res.status(500).json({ error: 'Error obteniendo usuarios' });
    }
  });

  router.post('/', requireRole('admin'), async (req, res) => {
    try {
      const { email, password, name, role, projectId } = req.body;
      if (!email || !password || !name) {
        return res.status(400).json({ error: 'email, password y name son requeridos' });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      const user = await userRepo.create({
        email,
        passwordHash,
        name,
        role,
        projectId: role === 'admin' ? null : projectId,
      });
      res.status(201).json(user);
    } catch (err) {
      console.error('users.routes POST /:', (err as Error).message);
      res.status(500).json({ error: 'Error creando usuario' });
    }
  });

  router.patch('/:id', canManage, async (req, res) => {
    try {
      const existing = await userRepo.findById(Number(req.params.id));
      if (!existing) return res.status(404).json({ error: 'Usuario no encontrado' });
      if (req.user!.projectId != null && existing.project_id !== req.user!.projectId) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      const { active } = req.body;
      const isAdmin = req.user!.role === 'admin';
      const wantsToDeactivate = active === false;
      const email = isAdmin ? req.body.email : undefined;
      const name = isAdmin ? req.body.name : undefined;
      const role = req.body.role;
      let projectId = isAdmin ? req.body.projectId : undefined;

      if (!isAdmin && role === 'admin') {
        return res.status(403).json({ error: 'No tiene permiso para asignar el rol admin' });
      }

      if (!isAdmin && wantsToDeactivate && existing.id === req.user!.id) {
        return res.status(403).json({ error: 'No puede desactivar su propia cuenta' });
      }

      const effectiveRole = role !== undefined ? role : existing.role;
      if (isAdmin && effectiveRole === 'admin') {
        projectId = null;
      }

      const wantsRoleChange = role !== undefined && role !== existing.role;
      if ((wantsToDeactivate || wantsRoleChange) && (await wouldRemoveLastActiveAdmin(existing))) {
        return res.status(400).json({
          error: 'No puede quedar el sistema sin ningún admin activo - cree/active otro admin antes de continuar',
        });
      }

      const user = await userRepo.update(Number(req.params.id), {
        email,
        name,
        role,
        active,
        projectId,
      });
      res.json(user);
    } catch (err) {
      if (err instanceof EmailAlreadyExistsError) {
        return res.status(409).json({ error: err.message, code: err.code });
      }
      console.error('users.routes PATCH /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error actualizando usuario' });
    }
  });

  router.post('/:id/password', requireRole('admin'), async (req, res) => {
    try {
      const { password } = req.body;
      if (!password) return res.status(400).json({ error: 'password requerido' });
      const passwordHash = await bcrypt.hash(password, 10);
      await userRepo.updatePassword(Number(req.params.id), passwordHash);
      res.json({ success: true });
    } catch (err) {
      console.error('users.routes POST /:id/password:', (err as Error).message);
      res.status(500).json({ error: 'Error actualizando contraseña' });
    }
  });

  router.delete('/:id', requireRole('admin'), async (req, res) => {
    try {
      const existing = await userRepo.findById(Number(req.params.id));
      if (!existing) return res.status(404).json({ error: 'Usuario no encontrado' });
      if (await wouldRemoveLastActiveAdmin(existing)) {
        return res.status(400).json({
          error: 'No puede eliminar al único admin activo - cree/active otro admin antes de continuar',
        });
      }

      const force = req.query.force === 'true';
      await userRepo.delete(Number(req.params.id), { force });
      res.json({ success: true });
    } catch (err) {
      if (err instanceof UserHasSessionsError) {
        return res.status(409).json({
          error:
            'El usuario tiene turnos de operador registrados - considere desactivarlo en vez de eliminarlo',
          code: err.code,
          hint: 'Reintente con ?force=true si desea eliminar también su historial de turnos',
        });
      }
      console.error('users.routes DELETE /:id:', (err as Error).message);
      res.status(500).json({ error: 'Error eliminando usuario' });
    }
  });

  return router;
}

export default buildUsersRouter;
