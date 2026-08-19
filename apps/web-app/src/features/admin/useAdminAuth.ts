import { clearSession, getStoredUser, type AuthUser } from '@gaga-gps/client';
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

export type AdminUser = AuthUser;

export function useAdminAuth() {
  const navigate = useNavigate();
  const user = getStoredUser()!;

  const logout = useCallback(() => {
    clearSession();
    navigate('/', { replace: true });
  }, [navigate]);

  return { user, logout };
}
