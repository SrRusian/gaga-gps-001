import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../backend/src/config/database';
import GeofenceRepository from '../../backend/src/repositories/GeofenceRepository';

const repo = new GeofenceRepository();
let testProjectId: number;
const createdGeofenceIds: number[] = [];

beforeAll(async () => {
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'geofences') THEN
        ALTER TABLE geofences ADD COLUMN IF NOT EXISTS geog GEOGRAPHY(GEOMETRY, 4326);
      END IF;
    END $$;
  `);

  const sql = fs.readFileSync(
    path.join(__dirname, '../../backend/db/001_init.sql'),
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
      latitude: 19.4,
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

    const onAxis = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 19.35,
      longitude: -103.55,
    });
    const onAxisRow = onAxis.find((g) => g.id === corridor.id);
    expect(onAxisRow).toBeDefined();
    expect(onAxisRow!.distance_meters).toBeLessThan(5);

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
        projectId: testProjectId,
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
