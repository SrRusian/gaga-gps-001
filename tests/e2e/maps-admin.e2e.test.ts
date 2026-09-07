import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// requiere el stack completo corriendo de verdad (npm run dev o docker compose up -d --build) -
// no arranca nada por su cuenta, a diferencia de los tests "integration" (que si levantan su
// propia conexion a Postgres). Ver config/vitest.config.mts (proyecto "e2e").
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3001';

// tests/e2e -> raiz del repo
const ALCARACES_DIR = path.resolve(__dirname, '../../files/TEST-FILES/Alcaraces');

const RUN_ID = Date.now();
const MAP_NAME = `TEST-mapa-e2e-${RUN_ID}`;
const PROJECT_NAME = `TEST-mapa-e2e-project-${RUN_ID}`;

interface MapRow {
  id: number;
  name: string;
  status: 'processing' | 'ready' | 'failed';
  active: boolean;
  source_crs: string | null;
  crs_auto_detected: boolean;
  bounds: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null;
  min_zoom: number | null;
  max_zoom: number | null;
  size_mb: number | null;
  error_message: string | null;
}

let token: string;
let projectId: number;
let mapId: number;

async function apiFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${BASE_URL}${pathname}`, { ...init, headers });
}

async function apiJson<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(pathname, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${init.method || 'GET'} ${pathname} -> ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function waitForMapStatus(
  id: number,
  targetStatuses: Array<MapRow['status']>,
  timeoutMs: number,
  intervalMs = 5000,
): Promise<MapRow> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const maps = await apiJson<MapRow[]>('/api/maps');
    const map = maps.find((m) => m.id === id);
    if (map && targetStatuses.includes(map.status)) return map;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timeout esperando que el mapa #${id} llegue a ${targetStatuses.join('/')}`);
}

beforeAll(async () => {
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@gaga.com', password: 'admin' }),
  });
  if (!loginRes.ok) {
    throw new Error(
      `No se pudo iniciar sesión contra ${BASE_URL} - ¿está el stack completo corriendo? (npm run dev / docker compose up -d --build)`,
    );
  }
  const login = (await loginRes.json()) as { token: string };
  token = login.token;

  const project = await apiJson<{ id: number }>('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: PROJECT_NAME }),
  });
  projectId = project.id;
});

afterAll(async () => {
  // limpieza: si el mapa sigue activo (un test falló a medio camino) desactivarlo antes de poder
  // borrar el proyecto/mapa - el mismo orden que exige la API (DELETE rechaza un mapa activo)
  if (mapId) {
    await apiFetch(`/api/maps/${mapId}/deactivate`, { method: 'POST' }).catch(() => {});
    await apiFetch(`/api/maps/${mapId}`, { method: 'DELETE' }).catch(() => {});
  }
  if (projectId) {
    await apiFetch(`/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => {});
  }
});

describe('Ciclo de vida completo de un mapa satelital (Alcaraces, GDAL real)', () => {
  it('importa el TIF+TFW real y llega a status=ready', async () => {
    const imageBuffer = readFileSync(path.join(ALCARACES_DIR, 'ALCARACES.tif'));
    const worldBuffer = readFileSync(path.join(ALCARACES_DIR, 'ALCARACES.tfw'));

    const form = new FormData();
    form.append('name', MAP_NAME);
    form.append('sourceCrs', 'EPSG:32613');
    form.append('projectId', String(projectId));
    form.append('image', new File([imageBuffer], 'ALCARACES.tif'));
    form.append('worldFile', new File([worldBuffer], 'ALCARACES.tfw'));

    const created = await apiJson<MapRow>('/api/maps', { method: 'POST', body: form });
    mapId = created.id;
    expect(created.status).toBe('processing');

    const finished = await waitForMapStatus(mapId, ['ready', 'failed'], 12 * 60 * 1000);

    if (finished.status === 'failed') {
      throw new Error(`El mapa terminó en "failed": ${finished.error_message}`);
    }

    expect(finished.status).toBe('ready');
    expect(finished.bounds).not.toBeNull();
    expect(finished.min_zoom).not.toBeNull();
    expect(finished.max_zoom).not.toBeNull();
    expect(finished.size_mb).toBeGreaterThan(0);
  });

  it('activa el mapa ya procesado', async () => {
    const activated = await apiJson<MapRow>(`/api/maps/${mapId}/activate`, { method: 'POST' });
    expect(activated.active).toBe(true);

    const activeMaps = await apiJson<{ id: number }[]>(
      `/tiles/active-maps.json`,
    );
    expect(activeMaps.some((m) => m.id === mapId)).toBe(true);
  });

  it('rechaza eliminar el mapa mientras sigue activo', async () => {
    const res = await apiFetch(`/api/maps/${mapId}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
  });

  it('desactiva y elimina el mapa - confirma que desaparece de la lista', async () => {
    const deactivated = await apiJson<MapRow>(`/api/maps/${mapId}/deactivate`, { method: 'POST' });
    expect(deactivated.active).toBe(false);

    const deleteRes = await apiFetch(`/api/maps/${mapId}`, { method: 'DELETE' });
    expect(deleteRes.ok).toBe(true);

    const remaining = await apiJson<MapRow[]>('/api/maps');
    expect(remaining.some((m) => m.id === mapId)).toBe(false);

    mapId = 0; // ya se limpio solo - afterAll no necesita repetirlo
  });
});
