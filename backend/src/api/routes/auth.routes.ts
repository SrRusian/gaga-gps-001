import bcrypt from 'bcryptjs';
import express from 'express';
import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config';
import type UserRepository from '../../repositories/UserRepository';

export function buildAuthRouter({
  userRepo,
  authMiddleware,
}: {
  userRepo: UserRepository;
  authMiddleware: RequestHandler;
}) {
  const router = express.Router();

  router.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email y contraseña requeridos' });
      }

      const user = await userRepo.findByEmail(email);
      if (!user || !user.active) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }

      const passwordMatches = await bcrypt.compare(password, user.password);
      if (!passwordMatches) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }

      const expiresIn: string =
        user.role === 'operator' ? env.operatorJwtExpiresIn : env.jwtExpiresIn;

      const token = jwt.sign(
        {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          projectId: user.project_id,
        },
        env.jwtSecret,
        {
          expiresIn,
        } as jwt.SignOptions,
      );

      console.log(`Login exitoso: ${user.email} (${user.role})`);

      res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          projectId: user.project_id,
        },
      });
    } catch (err) {
      console.error('auth.routes /login:', (err as Error).message);
      res.status(500).json({ error: 'Error interno de autenticación' });
    }
  });

  router.post('/logout', (req, res) => {
    res.json({ success: true });
  });

  // ubicacion aproximada capturada una sola vez al iniciar sesion (roles no-operador, ver
  // LoginScreen.tsx) - fire-and-forget del lado del cliente, nunca bloquea el login
  router.patch('/me/location', authMiddleware, async (req, res) => {
    try {
      const lat = Number(req.body?.lat);
      const lon = Number(req.body?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return res.status(400).json({ error: 'lat/lon inválidos' });
      }
      await userRepo.updateLastLoginLocation(req.user!.id, lat, lon);
      res.json({ success: true });
    } catch (err) {
      console.error('auth.routes PATCH /me/location:', (err as Error).message);
      res.status(500).json({ error: 'Error guardando ubicación' });
    }
  });

  return router;
}

export default buildAuthRouter;
