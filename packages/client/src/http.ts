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
  baseUrl?: string;
  getToken?: () => string | null | undefined;
  onUnauthorized?: () => void;
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
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
