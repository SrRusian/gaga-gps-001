/**
 * users.routes.ts
 *
 * CRUD de usuarios (operadores, supervisores, admins) para el
 * panel /administrator. Solo accesible por rol 'admin' (ver auth.middleware).
 */
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

  // Admin y Encargado de Proyecto pueden ver/editar; solo Admin crea
  // o elimina (ver plan de roles - un Encargado no da de alta cuentas
  // nuevas, solo administra las que ya existen en su proyecto).
  const canManage = requireRole('admin', 'project_manager');

  /**
   * true si desactivar/eliminar/cambiar de rol a `existing` dejaría
   * el sistema sin ningún admin activo capaz de volver a entrar -
   * el auto-bloqueo real que motivó esta función (ver CLAUDE.md).
   */
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
      // Admin es alcance global por diseño - project_id = NULL es el
      // único estado válido para este rol en todo el sistema (ver
      // README "Multi-tenencia por proyecto"). No confiar en que el
      // cliente ya lo mande así - forzarlo aquí, la ruta es la única
      // verdad.
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
      // Email/nombre son datos de identidad de la cuenta, no permisos
      // operativos - exclusivos del Admin global. Reasignar de
      // proyecto también (un Encargado nunca elige, siempre es el
      // suyo, no hay nada que reasignar). Rol y activo/inactivo SÍ
      // los puede tocar un Encargado sobre los usuarios de su propio
      // proyecto (el guard de más abajo ya garantizó que `existing`
      // pertenece a su proyecto) - es la única diferencia real de
      // permisos con el Admin en esta ruta.
      const email = isAdmin ? req.body.email : undefined;
      const name = isAdmin ? req.body.name : undefined;
      const role = req.body.role;
      let projectId = isAdmin ? req.body.projectId : undefined;

      // Asignar el rol admin le daría a otra cuenta alcance global,
      // saltándose por completo el límite "solo su proyecto" que
      // define a un Encargado - la única acción de este endpoint que
      // sigue siendo exclusiva del Admin global.
      if (!isAdmin && role === 'admin') {
        return res.status(403).json({ error: 'No tiene permiso para asignar el rol admin' });
      }

      // Un Encargado no puede desactivarse a sí mismo - a diferencia
      // de Admin (que puede reactivarse con otra cuenta admin si
      // existe), un Encargado desactivado se queda fuera de su propio
      // proyecto sin ninguna otra cuenta que pueda revertirlo -
      // auto-bloqueo real, mismo espíritu que el guard de
      // `wouldRemoveLastActiveAdmin` de más abajo, pero para este rol.
      if (!isAdmin && wantsToDeactivate && existing.id === req.user!.id) {
        return res.status(403).json({ error: 'No puede desactivar su propia cuenta' });
      }

      // Admin es alcance global por diseño - project_id = NULL es el
      // único estado válido para este rol (ver guard equivalente en
      // POST /). Se evalúa el rol EFECTIVO tras este PATCH (el nuevo
      // si viene en el body, si no el que ya tenía), para cubrir tanto
      // "lo estoy convirtiendo en admin ahora" como "ya era admin y
      // solo le estoy tocando otro campo".
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

      // ?force=true purga también sus turnos de operador registrados
      // - acción destructiva explícita, no es el comportamiento por
      // defecto (se recomienda desactivar para conservar el historial).
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
