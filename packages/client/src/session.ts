/**
 * session.ts
 *
 * Sesión de autenticación — un solo login (apps/web-app,
 * features/auth) para los 3 roles, con navegación client-side vía
 * React Router (ver ProtectedRoute) en vez de recargar la página.
 */

export const AUTH_TOKEN_KEY = 'gaga_auth_token';
export const AUTH_USER_KEY = 'gaga_auth_user';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: string;
}

export function getStoredToken(): string | null {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

export function getStoredUser(): AuthUser | null {
  const raw = localStorage.getItem(AUTH_USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function saveSession(token: string, user: AuthUser): void {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
}

/**
 * Recarga completa a la raíz (login) — reservado para el caso
 * excepcional de un 401 a media sesión (token vencido/revocado),
 * detectado fuera de un componente de React (dentro de
 * `createApiClient({ onUnauthorized })`, sin acceso a
 * `useNavigate()`). La navegación normal (login exitoso, logout,
 * ProtectedRoute) usa React Router y no recarga la página.
 */
export function goToLogin(): void {
  window.location.href = '/';
}
