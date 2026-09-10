export const AUTH_TOKEN_KEY = 'gaga_auth_token';
export const AUTH_USER_KEY = 'gaga_auth_user';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: string;
  projectId: number | null;
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

export function goToLogin(): void {
  window.location.href = '/';
}

const INTENTIONAL_LOGOUT_AT_KEY = 'gaga_intentional_logout_at';
// tiempo suficiente para que alguien llegue a Ajustes con calma tras cerrar sesion a mano - pasado
// esto, el auto-login (ver LoginScreen.tsx) vuelve a su comportamiento normal solo
const AUTO_LOGIN_SUPPRESS_WINDOW_MS = 5 * 60 * 1000;

// se llama junto a clearSession() SOLO cuando una persona presiona "cerrar sesion" a proposito -
// nunca en un logout forzado (token invalido/expirado, AUTH_FAILED del socket), donde SI se quiere
// que el auto-login (si esta configurado) reintente entrar solo de inmediato, no que se quede
// esperando a alguien que no esta ahi
export function markIntentionalLogout(): void {
  localStorage.setItem(INTENTIONAL_LOGOUT_AT_KEY, String(Date.now()));
}

export function isAutoLoginSuppressed(): boolean {
  const raw = localStorage.getItem(INTENTIONAL_LOGOUT_AT_KEY);
  if (!raw) return false;
  return Date.now() - Number(raw) < AUTO_LOGIN_SUPPRESS_WINDOW_MS;
}
