/**
 * GeofenceRepository.integration.test.ts
 *
 * Test de integración real contra Postgres+PostGIS - a diferencia
 * del resto de la suite (fakes en memoria), este conecta a la misma
 * instancia de Docker Compose que ya usa el flujo de desarrollo local
 * ("npm run dev"). Corre con "npm run test:integration" (config
 * aparte, ver vitest.integration.config.mts), no con "npm test".
 *
 * Requiere Postgres arriba (`docker compose up -d postgres`, ya lo
 * hace automático el script "pretest:integration" del package.json
 * raíz) y las variables DB_HOST/DB_PORT/etc. resueltas igual que el
 * backend real (config/database.ts), por defecto localhost:5432.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../config/database';
import GeofenceRepository from './GeofenceRepository';

const repo = new GeofenceRepository();
let testProjectId: number;
const createdGeofenceIds: number[] = [];

beforeAll(async () => {
  // 001_init.sql es 100% idempotente (CREATE TABLE/INDEX IF NOT
  // EXISTS) - seguro de re-aplicar contra una DB de desarrollo que ya
  // tiene datos reales, garantiza que la columna `geog`/el índice
  // GiST existan aunque el volumen local sea de antes de esta ronda.
  // CREATE TABLE IF NOT EXISTS (más abajo) no altera una tabla que ya
  // existía ANTES de que se agregara `geog` (ej. el volumen de Docker
  // de un dev que ya venía usando el proyecto) - se agrega a mano
  // ANTES de aplicar el resto del archivo, porque 001_init.sql ya
  // trae su propio `CREATE INDEX ... (geog)` que fallaría si la
  // columna todavía no existe. Igual que ya se hace manualmente
  // contra contenedores vivos en este proyecto (ver CLAUDE.md) -
  // ambas sentencias son idempotentes.
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'geofences') THEN
        ALTER TABLE geofences ADD COLUMN IF NOT EXISTS geog GEOGRAPHY(GEOMETRY, 4326);
      END IF;
    END $$;
  `);

  const sql = fs.readFileSync(
    path.join(__dirname, '../../../../db/migrations/001_init.sql'),
    'utf-8',
  );
  await pool.query(sql);

  const { rows } = await query<{ id: number }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`test-postgis-${Date.now()}`],
  );
  testProjectId = rows[0].id;
});

afterAll(async () => {
  if (createdGeofenceIds.length > 0) {
    await query('DELETE FROM geofences WHERE id = ANY($1)', [createdGeofenceIds]);
  }
  if (testProjectId) {
    await query('DELETE FROM projects WHERE id = $1', [testProjectId]);
  }
  await pool.end();
});

describe('GeofenceRepository - PostGIS real', () => {
  it('círculo: findMatchingSpatial matchea un punto dentro del radio y no uno fuera', async () => {
    const circle = await repo.create({
      name: 'Círculo de prueba',
      projectId: testProjectId,
      type: 'danger',
      shapeType: 'circle',
      centerLat: 19.35,
      centerLon: -103.56,
      radiusMeters: 100,
    });
    createdGeofenceIds.push(circle.id);

    const inside = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 19.35,
      longitude: -103.56,
    });
    expect(inside.map((g) => g.id)).toContain(circle.id);

    const outside = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 19.4, // ~6km de distancia - muy fuera del radio de 100m
      longitude: -103.6,
    });
    expect(outside.map((g) => g.id)).not.toContain(circle.id);
  });

  it('polígono: findMatchingSpatial matchea un punto dentro y no uno fuera', async () => {
    const polygon = await repo.create({
      name: 'Polígono de prueba',
      projectId: testProjectId,
      type: 'warning',
      shapeType: 'polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-103.561, 19.349],
            [-103.559, 19.349],
            [-103.559, 19.351],
            [-103.561, 19.351],
            [-103.561, 19.349],
          ],
        ],
      },
    });
    createdGeofenceIds.push(polygon.id);

    const inside = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 19.35,
      longitude: -103.56,
    });
    expect(inside.map((g) => g.id)).toContain(polygon.id);

    const outside = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 19.4,
      longitude: -103.6,
    });
    expect(outside.map((g) => g.id)).not.toContain(polygon.id);
  });

  it('corredor: siempre vuelve (la severidad la calcula quien llama) con distance_meters correcto', async () => {
    const corridor = await repo.create({
      name: 'Corredor de prueba',
      projectId: testProjectId,
      type: 'warning',
      shapeType: 'polyline',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-103.6, 19.35],
          [-103.5, 19.35],
        ],
      },
      corridorWidthMeters: 20,
    });
    createdGeofenceIds.push(corridor.id);

    // Sobre el eje exacto -> distancia ~0
    const onAxis = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 19.35,
      longitude: -103.55,
    });
    const onAxisRow = onAxis.find((g) => g.id === corridor.id);
    expect(onAxisRow).toBeDefined();
    expect(onAxisRow!.distance_meters).toBeLessThan(5);

    // Lejos del eje (~1.1km al norte) - misma fila, distancia grande
    const farFromAxis = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 19.36,
      longitude: -103.55,
    });
    const farRow = farFromAxis.find((g) => g.id === corridor.id);
    expect(farRow).toBeDefined();
    expect(farRow!.distance_meters).toBeGreaterThan(1000);
  });

  it('aislamiento por proyecto: una geocerca de otro proyecto nunca matchea', async () => {
    const { rows } = await query<{ id: number }>(
      `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
      [`test-postgis-other-${Date.now()}`],
    );
    const otherProjectId = rows[0].id;

    const circle = await repo.create({
      name: 'Círculo de otro proyecto',
      projectId: otherProjectId,
      type: 'danger',
      shapeType: 'circle',
      centerLat: 19.35,
      centerLon: -103.56,
      radiusMeters: 100,
    });

    try {
      const matches = await repo.findMatchingSpatial({
        projectId: testProjectId, // el proyecto de prueba, NO el del círculo
        latitude: 19.35,
        longitude: -103.56,
      });
      expect(matches.map((g) => g.id)).not.toContain(circle.id);
    } finally {
      await query('DELETE FROM geofences WHERE id = $1', [circle.id]);
      await query('DELETE FROM projects WHERE id = $1', [otherProjectId]);
    }
  });

  it('update() recalcula geog - mover el centro de un círculo cambia qué punto matchea', async () => {
    const circle = await repo.create({
      name: 'Círculo movible',
      projectId: testProjectId,
      type: 'warning',
      shapeType: 'circle',
      centerLat: 0,
      centerLon: 0,
      radiusMeters: 50,
    });
    createdGeofenceIds.push(circle.id);

    let matches = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 19.35,
      longitude: -103.56,
    });
    expect(matches.map((g) => g.id)).not.toContain(circle.id);

    await repo.update(circle.id, { centerLat: 19.35, centerLon: -103.56 });

    matches = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 19.35,
      longitude: -103.56,
    });
    expect(matches.map((g) => g.id)).toContain(circle.id);
  });

  it('projectId null (dispositivo sin proyecto) no matchea ninguna geocerca real', async () => {
    const circle = await repo.create({
      name: 'Círculo con proyecto real',
      projectId: testProjectId,
      type: 'danger',
      shapeType: 'circle',
      centerLat: 19.35,
      centerLon: -103.56,
      radiusMeters: 100,
    });
    createdGeofenceIds.push(circle.id);

    const matches = await repo.findMatchingSpatial({
      projectId: null,
      latitude: 19.35,
      longitude: -103.56,
    });
    expect(matches).toHaveLength(0);
  });
});
