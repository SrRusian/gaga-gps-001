/**
 * auth.routes.js
 *
 * Responsabilidad: Login/logout con JWT para el panel admin.
 * Los tokens se validan con auth.middleware.js en las rutas
 * protegidas del panel.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { env } = require('../../config');

function buildAuthRouter({ userRepo }) {
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

      // longLived: usado por la UI de operador (tableta fija en el
      // vehículo) — se espera que el turno persista por varios días
      // sin forzar re-login constante; el panel admin sigue usando
      // la expiración corta (env.jwtExpiresIn) por defecto.
      const expiresIn = req.body.longLived ? env.operatorJwtExpiresIn : env.jwtExpiresIn;

      const token = jwt.sign(
        { id: user.id, email: user.email, name: user.name, role: user.role },
        env.jwtSecret,
        { expiresIn }
      );

      console.log(`✅ Login exitoso: ${user.email} (${user.role})`);

      res.json({
        token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role }
      });
    } catch (err) {
      console.error('❌ auth.routes /login:', err.message);
      res.status(500).json({ error: 'Error interno de autenticación' });
    }
  });

  // El logout es responsabilidad del cliente (descartar el token);
  // se expone el endpoint para futura invalidación/blacklist si aplica.
  router.post('/logout', (req, res) => {
    res.json({ success: true });
  });

  return router;
}

module.exports = buildAuthRouter;
