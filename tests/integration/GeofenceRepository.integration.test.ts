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

  // 'authorized_route' quedo fuera a proposito de este mecanismo generico (ver test dedicado mas
  // abajo) - se usa 'danger' aqui para seguir cubriendo el mecanismo "debe quedarse dentro" para
  // cualquier OTRO tipo de linea que lo use (ej. un limite que de verdad debe alertar al salirse)
  it('línea "debe quedarse dentro" (stayInside=true, default, tipo != authorized_route): matchea lejos del eje, no cerca', async () => {
    const route = await repo.create({
      name: 'Línea de prueba',
      projectId: testProjectId,
      type: 'danger',
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
    createdGeofenceIds.push(route.id);

    const onAxis = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 19.35,
      longitude: -103.55,
    });
    expect(onAxis.map((g) => g.id)).not.toContain(route.id);

    const farFromAxis = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 19.36,
      longitude: -103.55,
    });
    expect(farFromAxis.map((g) => g.id)).toContain(route.id);
  });

  // authorized_route nunca alerta (fuera de AREA_SEVERITY en GeofenceAlertService) - su unico
  // proposito en este WHERE es aportar speed_limit_kmh mientras el vehiculo va SOBRE la ruta, sin
  // importar stay_inside. Bug real encontrado y corregido en esta misma ronda: antes matcheaba al
  // reves (lejos del eje), asi que el limite de velocidad de una ruta nunca aplicaba yendo sobre ella.
  it('línea "authorized_route" matchea DENTRO del corredor (para el límite de velocidad), no lejos', async () => {
    const route = await repo.create({
      name: 'Ruta de prueba',
      projectId: testProjectId,
      type: 'authorized_route',
      shapeType: 'polyline',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-103.6, 19.37],
          [-103.5, 19.37],
        ],
      },
      corridorWidthMeters: 20,
      speedLimitKmh: 30,
    });
    createdGeofenceIds.push(route.id);

    const onAxis = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 19.37,
      longitude: -103.55,
    });
    expect(onAxis.map((g) => g.id)).toContain(route.id);
    expect(onAxis.find((g) => g.id === route.id)?.speed_limit_kmh).toBe(30);

    const farFromAxis = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 19.4,
      longitude: -103.55,
    });
    expect(farFromAxis.map((g) => g.id)).not.toContain(route.id);
  });

  it('línea "no tocar" (stayInside=false): matchea cerca del eje, no lejos', async () => {
    const keepAway = await repo.create({
      name: 'Línea a no tocar',
      projectId: testProjectId,
      type: 'danger',
      shapeType: 'polyline',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-103.6, 19.34],
          [-103.5, 19.34],
        ],
      },
      corridorWidthMeters: 20,
      stayInside: false,
    });
    createdGeofenceIds.push(keepAway.id);

    const onAxis = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 19.34,
      longitude: -103.55,
    });
    expect(onAxis.map((g) => g.id)).toContain(keepAway.id);

    const farFromAxis = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 19.35,
      longitude: -103.55,
    });
    expect(farFromAxis.map((g) => g.id)).not.toContain(keepAway.id);
  });

  it('polígono sin relleno (filled=false): matchea cerca del borde, no en el centro ni muy lejos', async () => {
    const unfilled = await repo.create({
      name: 'Polígono sin relleno de prueba',
      projectId: testProjectId,
      type: 'forbidden',
      shapeType: 'polygon',
      filled: false,
      corridorWidthMeters: 15,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-103.581, 19.329],
            [-103.579, 19.329],
            [-103.579, 19.331],
            [-103.581, 19.331],
            [-103.581, 19.329],
          ],
        ],
      },
    });
    createdGeofenceIds.push(unfilled.id);

    const nearBorder = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 19.329,
      longitude: -103.58,
    });
    expect(nearBorder.map((g) => g.id)).toContain(unfilled.id);

    const centerOfPolygon = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 19.33,
      longitude: -103.58,
    });
    expect(centerOfPolygon.map((g) => g.id)).not.toContain(unfilled.id);

    const farOutside = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 19.4,
      longitude: -103.6,
    });
    expect(farOutside.map((g) => g.id)).not.toContain(unfilled.id);
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

  it('circulo: contained=true adentro, contained=false y distance_meters>0 dentro del buffer de proximidad', async () => {
    const circle = await repo.create({
      name: 'Círculo de proximidad',
      projectId: testProjectId,
      type: 'danger',
      shapeType: 'circle',
      centerLat: -10.35,
      centerLon: -150.56,
      radiusMeters: 50,
    });
    createdGeofenceIds.push(circle.id);

    const inside = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: -10.35,
      longitude: -150.56,
    });
    const insideRow = inside.find((g) => g.id === circle.id);
    expect(insideRow?.contained).toBe(true);
    expect(insideRow?.distance_meters).toBe(0);

    // ~67m del centro (17m fuera del radio de 50m) - sin buffer de proximidad no deberia matchear
    const nearWithoutBuffer = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: -10.3506,
      longitude: -150.56,
    });
    expect(nearWithoutBuffer.map((g) => g.id)).not.toContain(circle.id);

    // mismo punto, ahora con alertableTypes+lookahead - debe matchear con contained=false
    const nearWithBuffer = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: -10.3506,
      longitude: -150.56,
      alertableTypes: ['danger'],
      proximityLookaheadMeters: 100,
    });
    const nearRow = nearWithBuffer.find((g) => g.id === circle.id);
    expect(nearRow?.contained).toBe(false);
    expect(nearRow?.distance_meters).toBeGreaterThan(0);
  });

  it('footprintWkt reemplaza al punto crudo - un rectangulo que toca el circulo matchea aunque su centro este afuera', async () => {
    const circle = await repo.create({
      name: 'Círculo con footprint',
      projectId: testProjectId,
      type: 'danger',
      shapeType: 'circle',
      centerLat: 5.1,
      centerLon: 120.2,
      radiusMeters: 10,
    });
    createdGeofenceIds.push(circle.id);

    // punto crudo centrado bien lejos del circulo - no deberia matchear
    const withoutFootprint = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 5.1005,
      longitude: 120.2,
    });
    expect(withoutFootprint.map((g) => g.id)).not.toContain(circle.id);

    // un rectangulo "vehiculo" grande centrado en el mismo punto lejano (~55m del circulo) SI
    // alcanza a tocarlo - su borde sur llega a ~4m del centro del circulo (radio 10m)
    const withFootprint = await repo.findMatchingSpatial({
      projectId: testProjectId,
      latitude: 5.1005,
      longitude: 120.2,
      footprintWkt:
        'POLYGON((120.19982 5.10104, 120.20018 5.10104, 120.20018 5.09996, 120.19982 5.09996, 120.19982 5.10104))',
    });
    const row = withFootprint.find((g) => g.id === circle.id);
    expect(row).toBeDefined();
    expect(row?.contained).toBe(true);
  });

  it('findRouteMembership: detecta la ruta y la fraccion de recorrido (0=inicio, 1=fin) de un punto dentro del corredor', async () => {
    const route = await repo.create({
      name: 'Ruta de prueba A-B',
      projectId: testProjectId,
      type: 'authorized_route',
      shapeType: 'polyline',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-140.0, 30.0], // A
          [-140.0, 30.01], // B - 10 puntos al norte, ~1.1km
        ],
      },
      corridorWidthMeters: 20,
    });
    createdGeofenceIds.push(route.id);

    const nearStart = await repo.findRouteMembership({
      projectId: testProjectId,
      latitude: 30.0005,
      longitude: -140.0,
    });
    expect(nearStart?.id).toBe(route.id);
    expect(nearStart?.lineFraction).toBeGreaterThan(0);
    expect(nearStart?.lineFraction).toBeLessThan(0.2);

    const nearEnd = await repo.findRouteMembership({
      projectId: testProjectId,
      latitude: 30.0095,
      longitude: -140.0,
    });
    expect(nearEnd?.lineFraction).toBeGreaterThan(0.8);

    const farAway = await repo.findRouteMembership({
      projectId: testProjectId,
      latitude: 31.0,
      longitude: -140.0,
    });
    expect(farAway).toBeNull();
  });

  it('findRouteMembership solo considera polyline tipo authorized_route, no una linea "no tocar"', async () => {
    const keepAway = await repo.create({
      name: 'Linea a no tocar de prueba',
      projectId: testProjectId,
      type: 'danger',
      shapeType: 'polyline',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-141.0, 30.0],
          [-141.0, 30.01],
        ],
      },
      corridorWidthMeters: 20,
      stayInside: false,
    });
    createdGeofenceIds.push(keepAway.id);

    const match = await repo.findRouteMembership({
      projectId: testProjectId,
      latitude: 30.0005,
      longitude: -141.0,
    });
    expect(match).toBeNull();
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
