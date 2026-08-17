import { clearSession, getStoredUser, type AuthUser } from '@gaga-gps/client';
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

export type AdminUser = AuthUser;

/**
 * ProtectedRoute ya garantizó que hay una sesión válida con rol
 * "admin" antes de que este componente exista - aquí solo se expone
 * el usuario (para mostrar nombre/rol) y logout.
 */
export function useAdminAuth() {
  const navigate = useNavigate();
  // Non-null: ProtectedRoute no deja montar AdminApp sin esto.
  const user = getStoredUser()!;

  const logout = useCallback(() => {
    clearSession();
    navigate('/', { replace: true });
  }, [navigate]);

  return { user, logout };
}
