import {
  ApiError,
  clearSession,
  createApiClient,
  getStoredToken,
  goToLogin,
} from '@gaga-gps/client';

export const adminApi = createApiClient({
  getToken: getStoredToken,
  onUnauthorized: () => {
    // Token vencido o revocado a media sesión (ej. un admin
    // desactivó a este usuario) — vuelve al login único.
    clearSession();
    goToLogin();
  },
});

export { ApiError };
