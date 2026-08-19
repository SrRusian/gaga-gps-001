import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config';
import type UserRepository from '../../repositories/UserRepository';

export function buildAuthRouter({ userRepo }: { userRepo: UserRepository }) {
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

  return router;
}

export default buildAuthRouter;
