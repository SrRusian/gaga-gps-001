import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// requiere el stack completo corriendo de verdad (npm run dev o docker compose up -d --build) -
// mismo patron que maps-admin.e2e.test.ts. Ver config/vitest.config.mts (proyecto "e2e").
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3001';

const RUN_ID = Date.now();
const PROJECT_NAME = `TEST-geofences-e2e-project-${RUN_ID}`;

// los 9 tipos semanticos reales (paleta fija en GEOFENCE_COLORS, backend/src/utils/geoFormats.ts
// y web/packages/map-core/src/geofenceLayer.ts) - si se agrega un tipo nuevo, agregarlo aqui tambien
const GEOFENCE_TYPES = [
  'warning',
  'danger',
  'parking',
  'forbidden',
  'authorized_route',
  'allowed',
  'discharge',
  'maintenance',
  'carga',
] as const;

interface GeofenceRow {
  id: number;
  name: string;
  type: (typeof GEOFENCE_TYPES)[number];
  active: boolean;
  project_id: number;
}

let token: string;
let projectId: number;
// geocercas creadas que no se hayan podido eliminar todavia (si un test falla a medio camino,
// afterAll las limpia igual)
const pendingIds = new Set<number>();

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

async function apiPost<T>(pathname: string, body: unknown): Promise<T> {
  return apiJson<T>(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// coordenadas de prueba deliberadamente lejos de cualquier posicion real (medio del Pacifico) -
// mismo criterio que el resto del proyecto para no colisionar con tabletas/dispositivos reales
const SAFE_LAT_RANGE: [number, number] = [-10, 10];
const SAFE_LON_RANGE: [number, number] = [-150, -130];

function randomInRange([min, max]: [number, number]): number {
  return min + Math.random() * (max - min);
}

// poligono aleatorio (cuadrado de lado variable) - geometria distinta en cada corrida, siempre
// dentro de la zona segura de prueba
function randomPolygon(): { type: 'Polygon'; coordinates: number[][][] } {
  const lat = randomInRange(SAFE_LAT_RANGE);
  const lon = randomInRange(SAFE_LON_RANGE);
  const size = 0.01 + Math.random() * 0.02;
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lon, lat],
        [lon + size, lat],
        [lon + size, lat + size],
        [lon, lat + size],
        [lon, lat],
      ],
    ],
  };
}

// linea aleatoria - solo para "authorized_route", que usa el mecanismo de corredor
// (corridorWidthMeters) en vez de area cerrada
function randomLineString(): { type: 'LineString'; coordinates: number[][] } {
  const lat = randomInRange(SAFE_LAT_RANGE);
  const lon = randomInRange(SAFE_LON_RANGE);
  const size = 0.01 + Math.random() * 0.02;
  return {
    type: 'LineString',
    coordinates: [
      [lon, lat],
      [lon + size, lat + size],
    ],
  };
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

  const project = await apiPost<{ id: number }>('/api/projects', { name: PROJECT_NAME });
  projectId = project.id;
});

afterAll(async () => {
  // limpieza de cualquier geocerca que un test fallido haya dejado sin borrar
  for (const id of pendingIds) {
    await apiFetch(`/api/geofences/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  if (projectId) {
    await apiFetch(`/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => {});
  }
});

describe('Ciclo de vida de geocercas para cada uno de los 9 tipos semánticos', () => {
  it.each(GEOFENCE_TYPES)(
    'crea, confirma que existe/se ve, y elimina una geocerca aleatoria de tipo "%s"',
    async (type) => {
      const name = `TEST-geo-${type}-${RUN_ID}`;
      const isRoute = type === 'authorized_route';

      const payload = isRoute
        ? {
            name,
            type,
            shapeType: 'polyline',
            geometry: randomLineString(),
            corridorWidthMeters: 15 + Math.random() * 30,
            projectId,
          }
        : { name, type, shapeType: 'polygon', geometry: randomPolygon(), projectId };

      const created = await apiPost<GeofenceRow>('/api/geofences', payload);
      pendingIds.add(created.id);
      expect(created.type).toBe(type);
      expect(created.name).toBe(name);
      expect(created.active).toBe(true);

      // "existe y se ve" - aparece en el mismo listado que alimenta la tabla de Geocercas del
      // panel, con su tipo correcto (el tipo es lo único que decide el color en el mapa - ver
      // GEOFENCE_COLORS en geoFormats.ts/geofenceLayer.ts, ya cubierto por pruebas unitarias)
      const listAfterCreate = await apiJson<GeofenceRow[]>(`/api/geofences`);
      const found = listAfterCreate.find((g) => g.id === created.id);
      expect(found).toBeDefined();
      expect(found!.type).toBe(type);
      expect(found!.active).toBe(true);

      const deleteRes = await apiFetch(`/api/geofences/${created.id}`, { method: 'DELETE' });
      expect(deleteRes.ok).toBe(true);

      const listAfterDelete = await apiJson<GeofenceRow[]>(`/api/geofences`);
      expect(listAfterDelete.some((g) => g.id === created.id)).toBe(false);

      pendingIds.delete(created.id);
    },
  );
});
