/**
 * http.ts
 *
 * Fetch tipado - reemplaza los patrones sueltos que hoy tiene cada
 * panel (`const BACKEND_URL = ""` / `const API = ""` + `fetch()`
 * directo). Same-origin por default (mismo criterio que los 3
 * paneles actuales), con adjunto opcional de JWT y manejo
 * consistente de errores/401.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  /** Vacío por default - mismo origen que la página, igual que hoy. */
  baseUrl?: string;
  /** Se llama en cada request - permite leer el token más reciente de localStorage. */
  getToken?: () => string | null | undefined;
  /** Se llama cuando el backend responde 401 - típico: cerrar sesión y redirigir al login. */
  onUnauthorized?: () => void;
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
  /** Para casos que no encajan en los helpers de arriba (multipart, etc.). */
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? '';

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = options.getToken?.();
    const headers = new Headers(init.headers);

    if (token) headers.set('Authorization', `Bearer ${token}`);

    const isPlainBody =
      init.body !== undefined && !(init.body instanceof FormData) && typeof init.body === 'string';
    if (isPlainBody && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const res = await fetch(`${baseUrl}${path}`, { ...init, headers });

    if (res.status === 401) {
      options.onUnauthorized?.();
    }

    if (!res.ok) {
      const errorBody = await res.json().catch(() => ({}));
      const message = (errorBody as { error?: string }).error || res.statusText;
      throw new ApiError(res.status, message, errorBody);
    }

    if (res.status === 204) return undefined as T;

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) return res.json() as Promise<T>;
    return res.text() as unknown as Promise<T>;
  }

  return {
    get: <T>(path: string) => request<T>(path),
    post: <T>(path: string, body?: unknown) =>
      request<T>(path, {
        method: 'POST',
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    patch: <T>(path: string, body?: unknown) =>
      request<T>(path, {
        method: 'PATCH',
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
    request,
  };
}
