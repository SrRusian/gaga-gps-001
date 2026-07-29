/**
 * auth.middleware.js
 *
 * Responsabilidad: Verificar el JWT en rutas protegidas del
 * panel admin y adjuntar el usuario decodificado a req.user.
 *
 * Además de validar firma/expiración, revalida contra PostgreSQL
 * que el usuario siga activo y conserve el rol del token — un JWT
 * emitido antes de desactivar/cambiar de rol a un usuario (válido
 * hasta JWT_EXPIRES_IN, 8h por defecto) no debe seguir autorizando
 * acciones críticas (p. ej. /api/fleet/stop, borrar geocercas).
 */

const jwt = require('jsonwebtoken');
const { env } = require('../../config');

function buildAuthMiddleware({ userRepo }) {
  return async function authMiddleware(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Token no proporcionado' });
    }

    try {
      const payload = jwt.verify(token, env.jwtSecret);

      const user = await userRepo.findById(payload.id);
      if (!user || !user.active) {
        return res.status(401).json({ error: 'Usuario inactivo o inexistente' });
      }
      if (user.role !== payload.role) {
        // El rol cambió después de emitido el token — se exige
        // reautenticación para reflejar los permisos vigentes.
        return res.status(401).json({ error: 'Los permisos del usuario cambiaron — vuelva a iniciar sesión' });
      }

      req.user = payload;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }
  };
}

/**
 * Middleware de autorización por rol — uso: requireRole('admin')
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'No autorizado para esta acción' });
    }
    next();
  };
}

module.exports = { buildAuthMiddleware, requireRole };

