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
    clearSession();
    goToLogin();
  },
});

export { ApiError };
