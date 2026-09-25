import type { Geofence } from '@gaga-gps/shared-types';
import { describe, expect, it } from 'vitest';
import { renderGeofences } from '../../../../../../web/packages/map-core/src/geofenceLayer';

// mapa minimo simulado a mano - solo lo que renderGeofences toca. Mismo criterio que
// vehicleMarker.test.ts: este proyecto no tiene infraestructura de tests de frontend, y no valia
// una dependencia nueva solo para esto.
function fakeMap() {
  const layers: Record<string, Record<string, unknown>> = {};
  return {
    layers,
    map: {
      isStyleLoaded: () => true,
      getSource: () => undefined,
      addSource: () => {},
      addLayer: (layer: { id: string } & Record<string, unknown>) => {
        layers[layer.id] = layer;
      },
      once: () => {},
    },
  };
}

function route(routeDirection: 'both' | 'forward'): Geofence {
  return {
    id: 1,
    name: 'Ruta',
    type: 'authorized_route',
    projectId: null,
    shapeType: 'polyline',
    // en V: baja a la derecha y regresa - cerrarla como anillo da un triangulo, que es
    // exactamente lo que se veia pintado sobre el mapa
    geometry: {
      type: 'LineString',
      coordinates: [
        [-103.7168, 19.2541],
        [-103.7159, 19.2533],
        [-103.7155, 19.2538],
      ],
    },
    corridorWidthMeters: 1,
    stayInside: true,
    routeDirection,
  } as Geofence;
}

describe('renderGeofences - la feature de flechas no debe pintarse como area', () => {
  // Bug real reportado con captura, visible en los 3 paneles: la LineString desnuda que existe
  // solo para colocar las flechas de sentido tambien la agarraban las capas de relleno y borde.
  // Una capa 'fill' trata una LineString como anillo de poligono y la cierra sola, pintando un
  // area falsa enorme sobre el mapa.
  it('las capas de relleno y borde excluyen la feature de flechas', () => {
    const { layers, map } = fakeMap();
    renderGeofences(map as never, [route('forward')]);

    for (const id of ['geofences-fill', 'geofences-line']) {
      expect(layers[id], `falta la capa ${id}`).toBeDefined();
      expect(layers[id].filter, `${id} sin filtro: pintaria la LineString de las flechas`).toEqual([
        '!',
        ['has', 'arrow'],
      ]);
    }
  });

  it('la capa de simbolos solo toma la feature de flechas', () => {
    const { layers, map } = fakeMap();
    renderGeofences(map as never, [route('forward')]);
    expect(layers['geofences-direction'].filter).toEqual(['has', 'arrow']);
  });

  it('una ruta bidireccional no genera feature de flechas', () => {
    const { map } = fakeMap();
    let data: { features: { properties: Record<string, unknown> }[] } | null = null;
    const capturing = {
      ...map,
      addSource: (_id: string, source: { data: typeof data }) => {
        data = source.data;
      },
    };
    renderGeofences(capturing as never, [route('both')]);
    expect(data!.features.some((f) => 'arrow' in f.properties)).toBe(false);
  });

  it('una ruta de un solo sentido genera la franja Y la feature de flechas', () => {
    const { map } = fakeMap();
    let data: { features: { properties: Record<string, unknown>; geometry: { type: string } }[] } | null = null;
    const capturing = {
      ...map,
      addSource: (_id: string, source: { data: typeof data }) => {
        data = source.data;
      },
    };
    renderGeofences(capturing as never, [route('forward')]);
    const features = data!.features;
    expect(features).toHaveLength(2);
    // la franja del corredor es un poligono; la de flechas conserva la linea real
    expect(features.find((f) => !('arrow' in f.properties))!.geometry.type).toBe('Polygon');
    const arrow = features.find((f) => 'arrow' in f.properties)!;
    expect(arrow.geometry.type).toBe('LineString');
    expect(arrow.properties.arrow).toBe('▶');
  });
});
