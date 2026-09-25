import { describe, expect, it } from 'vitest';
import type { Geofence } from '@gaga-gps/shared-types';
import {
  evaluateGeofencesNearby,
  evaluateGeofencesOffline,
  evaluateRouteDirection,
  locateOnAuthorizedRoute,
  locateOnPath,
} from '../../../../../../app/packages/operator-ui/src/offlineGeofences';

// cuadrado de ~222m de lado centrado en (19.35, -103.56) - 0.001 grados son ~111m
const CENTER = { lat: 19.35, lon: -103.56 };
const SQUARE: number[][] = [
  [-103.561, 19.349],
  [-103.559, 19.349],
  [-103.559, 19.351],
  [-103.561, 19.351],
  [-103.561, 19.349],
];

function polygon(over: Partial<Geofence> = {}): Geofence {
  return {
    id: 1,
    name: 'Zona',
    type: 'danger',
    projectId: null,
    shapeType: 'polygon',
    geometry: { type: 'Polygon', coordinates: [SQUARE] },
    filled: true,
    ...over,
  } as Geofence;
}

function line(over: Partial<Geofence> = {}): Geofence {
  return {
    id: 2,
    name: 'Linea',
    type: 'danger',
    projectId: null,
    shapeType: 'polyline',
    geometry: { type: 'LineString', coordinates: [[-103.561, 19.35], [-103.559, 19.35]] },
    corridorWidthMeters: 50,
    stayInside: true,
    ...over,
  } as Geofence;
}

describe('evaluateGeofencesOffline', () => {
  it('poligono con relleno: alerta dentro, nada fuera', () => {
    const inside = evaluateGeofencesOffline(CENTER.lat, CENTER.lon, [polygon()]);
    expect(inside?.severity).toBe('danger');
    expect(inside?.message).toContain('DETENER');
    expect(evaluateGeofencesOffline(19.36, CENTER.lon, [polygon()])).toBeNull();
  });

  it('circulo: alerta dentro del radio, nada fuera', () => {
    const circle = {
      id: 3, name: 'Circulo', type: 'warning', projectId: null,
      shapeType: 'circle', center: CENTER, radiusMeters: 100,
    } as Geofence;
    expect(evaluateGeofencesOffline(19.3505, CENTER.lon, [circle])?.severity).toBe('warning');
    expect(evaluateGeofencesOffline(19.352, CENTER.lon, [circle])).toBeNull();
  });

  it('poligono sin relleno: alerta cerca del borde, no en el centro', () => {
    const unfilled = polygon({ filled: false, corridorWidthMeters: 60 } as Partial<Geofence>);
    expect(evaluateGeofencesOffline(19.3505, CENTER.lon, [unfilled])).not.toBeNull();
    expect(evaluateGeofencesOffline(CENTER.lat, CENTER.lon, [unfilled])).toBeNull();
  });

  it('linea "debe quedarse dentro": alerta al SALIR del ancho', () => {
    expect(evaluateGeofencesOffline(CENTER.lat, -103.56, [line()])).toBeNull();
    expect(evaluateGeofencesOffline(19.351, -103.56, [line()])).not.toBeNull();
  });

  it('linea "no tocar": alerta al ENTRAR al ancho (sentido inverso)', () => {
    const noTouch = line({ stayInside: false } as Partial<Geofence>);
    expect(evaluateGeofencesOffline(CENTER.lat, -103.56, [noTouch])).not.toBeNull();
    expect(evaluateGeofencesOffline(19.351, -103.56, [noTouch])).toBeNull();
  });

  it('tipos informativos nunca alertan, ni estando dentro', () => {
    for (const type of ['allowed', 'discharge', 'carga', 'authorized_route'] as const) {
      expect(evaluateGeofencesOffline(CENTER.lat, CENTER.lon, [polygon({ type })])).toBeNull();
    }
  });

  it('con varias geocercas encima gana la de mayor severidad', () => {
    const zones = [
      polygon({ id: 10, type: 'warning', name: 'Precaucion' }),
      polygon({ id: 11, type: 'danger', name: 'Peligro' }),
    ];
    const match = evaluateGeofencesOffline(CENTER.lat, CENTER.lon, zones);
    expect(match?.severity).toBe('danger');
    expect(match?.geofenceId).toBe(11);
  });

  // el borde SUR del cuadrado esta en lat=19.349 (SQUARE arriba) - un punto justo debajo (lat menor)
  // esta fuera por el test de punto crudo, pero un vehiculo de 10x4m centrado 3m al sur, apuntando
  // al norte (heading 0), llega hasta ~2m dentro del poligono - exactamente el bug reportado en
  // campo: "zona prohibida" no avisaba hasta que el CENTRO exacto tocaba el poligono
  const JUST_OUTSIDE_SOUTH_EDGE = { lat: 19.349 - 3 / 111320, lon: -103.56 };
  const FOOTPRINT_10X4_NORTH = { headingDeg: 0, lengthMeters: 10, widthMeters: 4 };

  it('punto crudo justo afuera del borde: sin footprint no alerta', () => {
    expect(
      evaluateGeofencesOffline(JUST_OUTSIDE_SOUTH_EDGE.lat, JUST_OUTSIDE_SOUTH_EDGE.lon, [polygon()]),
    ).toBeNull();
  });

  it('con la silueta real del vehiculo, tocar el borde SI alerta aunque el centro este afuera', () => {
    const match = evaluateGeofencesOffline(
      JUST_OUTSIDE_SOUTH_EDGE.lat,
      JUST_OUTSIDE_SOUTH_EDGE.lon,
      [polygon()],
      FOOTPRINT_10X4_NORTH,
    );
    expect(match?.severity).toBe('danger');
  });

  it('silueta real lejos del borde (mismo vehiculo, mas al sur): no alerta', () => {
    const farSouth = { lat: 19.349 - 50 / 111320, lon: -103.56 };
    expect(
      evaluateGeofencesOffline(farSouth.lat, farSouth.lon, [polygon()], FOOTPRINT_10X4_NORTH),
    ).toBeNull();
  });

  it('circulo: la silueta real toca aunque el centro del vehiculo este fuera del radio', () => {
    const circle = {
      id: 3, name: 'Circulo', type: 'danger', projectId: null,
      shapeType: 'circle', center: CENTER, radiusMeters: 100,
    } as Geofence;
    // centro del vehiculo a 103m del centro del circulo (fuera del radio de 100m), pero con un
    // vehiculo de 10m de largo orientado hacia el circulo la silueta si llega a tocar el borde
    const justOutsideRadius = { lat: CENTER.lat + 103 / 111320, lon: CENTER.lon };
    expect(evaluateGeofencesOffline(justOutsideRadius.lat, justOutsideRadius.lon, [circle])).toBeNull();
    expect(
      evaluateGeofencesOffline(justOutsideRadius.lat, justOutsideRadius.lon, [circle], {
        headingDeg: 180, // apuntando hacia el centro del circulo (al sur)
        lengthMeters: 10,
        widthMeters: 4,
      }),
    ).not.toBeNull();
  });

  describe('evaluateGeofencesNearby (aviso temprano por precision GPS)', () => {
    it('el circulo de precision toca el borde: avisa "warning" aunque el punto/silueta no toquen', () => {
      const nearby = evaluateGeofencesNearby(
        JUST_OUTSIDE_SOUTH_EDGE.lat,
        JUST_OUTSIDE_SOUTH_EDGE.lon,
        [polygon()],
        5, // 5m de precision GPS - el punto esta a 3m del borde, el circulo si lo toca
      );
      expect(nearby?.severity).toBe('warning');
      expect(nearby?.message).toContain('ACERCÁNDOSE');
    });

    it('sin precision suficiente para tocar el borde: no avisa', () => {
      expect(
        evaluateGeofencesNearby(JUST_OUTSIDE_SOUTH_EDGE.lat, JUST_OUTSIDE_SOUTH_EDGE.lon, [polygon()], 1),
      ).toBeNull();
    });

    it('si la silueta real ya toca de verdad, no hay aviso temprano duplicado (ese ya gano)', () => {
      const nearby = evaluateGeofencesNearby(
        JUST_OUTSIDE_SOUTH_EDGE.lat,
        JUST_OUTSIDE_SOUTH_EDGE.lon,
        [polygon()],
        5,
        FOOTPRINT_10X4_NORTH,
      );
      expect(nearby).toBeNull();
    });

    it('poligono sin relleno y polilinea: fuera de alcance a proposito (solo circulo/poligono relleno)', () => {
      const unfilled = polygon({ filled: false, corridorWidthMeters: 5 } as Partial<Geofence>);
      // lejos del borde de deteccion (60m+ dentro del cuadrado) - ni siquiera el "real" deberia tocar,
      // y el aviso temprano nunca aplica a este tipo de forma de todas formas
      expect(evaluateGeofencesNearby(CENTER.lat, CENTER.lon, [unfilled], 5)).toBeNull();
      expect(evaluateGeofencesNearby(CENTER.lat, -103.56, [line()], 5)).toBeNull();
    });

    // pregunta real del usuario: "si mi area aproximada de precision es de 5 metros o mas, ese
    // circulo se toma correctamente cuando su zona o incluso apenas con sus bordes alerta de
    // advertencia al tocar una zona de advertencia?" - probado explicitamente contra una geocerca
    // type:'warning' (no danger/forbidden como el resto de los tests de arriba), y en el limite
    // matematico exacto (5.0m alcanza, 5.0m+1cm ya no) para confirmar que es el borde real del
    // circulo, no un margen aproximado
    it('zona type warning: el circulo de precision SI avisa "advertencia" aunque solo toque con el borde', () => {
      const warningZone = polygon({ type: 'warning' });
      const nearby = evaluateGeofencesNearby(
        JUST_OUTSIDE_SOUTH_EDGE.lat, // exactamente a 3.000m del borde (ver constante arriba)
        JUST_OUTSIDE_SOUTH_EDGE.lon,
        [warningZone],
        5,
      );
      expect(nearby?.severity).toBe('warning');
      expect(nearby?.geofenceType).toBe('warning');
      expect(nearby?.message).toBe('PRECAUCIÓN - ACERCÁNDOSE A ZONA DE RIESGO');
    });

    it('el borde del circulo de precision es el limite real, no una aproximacion con margen', () => {
      // el punto esta a 3m del borde - con exactamente 3m de precision el circulo apenas ALCANZA a
      // tocar el borde (avisa); con un pelo menos (2.99m) ya no llega (no avisa)
      expect(
        evaluateGeofencesNearby(JUST_OUTSIDE_SOUTH_EDGE.lat, JUST_OUTSIDE_SOUTH_EDGE.lon, [polygon()], 3),
      ).not.toBeNull();
      expect(
        evaluateGeofencesNearby(JUST_OUTSIDE_SOUTH_EDGE.lat, JUST_OUTSIDE_SOUTH_EDGE.lon, [polygon()], 2.99),
      ).toBeNull();
    });
  });

  it('un agujero del poligono no cuenta como dentro', () => {
    const withHole = polygon({
      geometry: {
        type: 'Polygon',
        coordinates: [SQUARE, [
          [-103.5605, 19.3495], [-103.5595, 19.3495],
          [-103.5595, 19.3505], [-103.5605, 19.3505], [-103.5605, 19.3495],
        ]],
      },
    } as Partial<Geofence>);
    expect(evaluateGeofencesOffline(CENTER.lat, CENTER.lon, [withHole])).toBeNull();
  });
});

// --- Rutas autorizadas con sentido ---
// La direccion no es geometria nueva: la polilinea ya viene ordenada, asi que la fraccion a lo
// largo de ella (0 = primer punto, 1 = ultimo) ya define un sentido.
function route(routeDirection: 'both' | 'forward' | 'backward'): Geofence {
  return {
    id: 90,
    name: 'Ruta Norte',
    type: 'authorized_route',
    projectId: null,
    shapeType: 'polyline',
    // ~1113 m de sur a norte sobre el mismo meridiano
    geometry: { type: 'LineString', coordinates: [[-103.72, 19.24], [-103.72, 19.25]] },
    corridorWidthMeters: 20,
    stayInside: true,
    routeDirection,
  } as Geofence;
}

describe('locateOnPath - equivalente local de ST_LineLocatePoint', () => {
  const path = [[-103.72, 19.24], [-103.72, 19.25]];

  it('el inicio de la linea es fraccion 0 y el final fraccion 1', () => {
    expect(locateOnPath(19.24, -103.72, path)!.fraction).toBeCloseTo(0, 3);
    expect(locateOnPath(19.25, -103.72, path)!.fraction).toBeCloseTo(1, 3);
  });

  it('a la mitad da 0.5 y distancia perpendicular cero', () => {
    const loc = locateOnPath(19.245, -103.72, path)!;
    expect(loc.fraction).toBeCloseTo(0.5, 2);
    expect(loc.distanceMeters).toBeLessThan(1);
  });

  it('un punto al costado conserva su avance y reporta la separacion real', () => {
    // ~10.5 m al este del punto medio
    const loc = locateOnPath(19.245, -103.71990, path)!;
    expect(loc.fraction).toBeCloseTo(0.5, 2);
    expect(loc.distanceMeters).toBeGreaterThan(8);
    expect(loc.distanceMeters).toBeLessThan(13);
  });

  it('una linea degenerada no revienta', () => {
    expect(locateOnPath(19.24, -103.72, [[-103.72, 19.24]])).toBeNull();
    expect(locateOnPath(19.24, -103.72, [[-103.72, 19.24], [-103.72, 19.24]])).toBeNull();
  });
});

describe('locateOnAuthorizedRoute', () => {
  it('fuera del corredor no cuenta como ir por esa ruta', () => {
    // ~105 m al este, muy fuera del corredor de 20 m
    expect(locateOnAuthorizedRoute(19.245, -103.719, [route('forward')])).toBeNull();
  });

  it('dentro del corredor la encuentra', () => {
    const found = locateOnAuthorizedRoute(19.245, -103.72, [route('forward')]);
    expect(found?.geofence.id).toBe(90);
  });
});

describe('evaluateRouteDirection', () => {
  const at = (lat: number) => locateOnPath(lat, -103.72, route('forward').geometry.coordinates)!;

  it('una ruta bidireccional nunca marca sentido contrario', () => {
    const r = evaluateRouteDirection(route('both'), at(19.245), 0.9);
    expect(r!.wrongWay).toBe(false);
  });

  it('avanzar en el orden de dibujo va bien en una ruta forward', () => {
    const r = evaluateRouteDirection(route('forward'), at(19.246), 0.5);
    expect(r!.wrongWay).toBe(false);
  });

  it('retroceder en una ruta forward es sentido contrario', () => {
    const r = evaluateRouteDirection(route('forward'), at(19.244), 0.5);
    expect(r!.wrongWay).toBe(true);
  });

  // 'backward' existe para invertir una ruta ya trazada sin volver a dibujarla
  it('en una ruta backward el criterio se invierte', () => {
    expect(evaluateRouteDirection(route('backward'), at(19.244), 0.5)!.wrongWay).toBe(false);
    expect(evaluateRouteDirection(route('backward'), at(19.246), 0.5)!.wrongWay).toBe(true);
  });

  it('un movimiento dentro de la zona muerta no decide nada (evita parpadeo)', () => {
    const loc = at(19.245);
    expect(evaluateRouteDirection(route('forward'), loc, loc.fraction)).toBeNull();
  });

  it('la primera muestra todavia no puede decidir sentido', () => {
    expect(evaluateRouteDirection(route('forward'), at(19.245), null)!.wrongWay).toBe(false);
  });

  // base del sistema de guiado: cuanto falta para llegar al extremo permitido
  it('lo que falta se mide hacia el extremo del sentido permitido', () => {
    const half = at(19.245);
    const fwd = evaluateRouteDirection(route('forward'), half, 0.4)!;
    const bwd = evaluateRouteDirection(route('backward'), half, 0.6)!;
    expect(fwd.remainingMeters).toBeCloseTo(bwd.remainingMeters, 0);
    expect(fwd.remainingMeters).toBeGreaterThan(500);
    expect(fwd.remainingMeters).toBeLessThan(600);
  });
});
