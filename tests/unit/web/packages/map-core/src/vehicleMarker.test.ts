import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVehicleMarkerElement } from '../../../../../../web/packages/map-core/src/vehicleMarker';

// DOM minimo simulado a proposito en vez de agregar jsdom: lo unico que se necesita verificar es
// que estilos quedan escritos en el elemento, y este proyecto no tiene infraestructura de tests de
// frontend (ver nota en CLAUDE.md) - no vale la pena una dependencia nueva por esto.
interface FakeElement {
  style: Record<string, string>;
  dataset: Record<string, string>;
  className: string;
  innerHTML: string;
  children: FakeElement[];
  appendChild(child: FakeElement): FakeElement;
}

function fakeElement(): FakeElement {
  const children: FakeElement[] = [];
  return {
    style: {},
    dataset: {},
    className: '',
    innerHTML: '',
    children,
    appendChild(child: FakeElement) {
      children.push(child);
      return child;
    },
  };
}

const originalDocument = (globalThis as { document?: unknown }).document;

describe('createVehicleMarkerElement', () => {
  beforeEach(() => {
    (globalThis as { document?: unknown }).document = { createElement: () => fakeElement() };
  });

  afterEach(() => {
    (globalThis as { document?: unknown }).document = originalDocument;
  });

  // Bug real reportado en campo: con position:relative el marcador vuelve al flujo normal del
  // documento y MapLibre mide su transform de posicion desde ahi y no desde el origen del mapa, asi
  // que cada marcador queda corrido una cantidad fija de pixeles hacia abajo. Imperceptible con
  // zoom cercano, decenas de km al alejar.
  it('el elemento raiz es absolute - MapLibre posiciona por transform desde el origen del mapa', () => {
    const el = createVehicleMarkerElement({ deviceId: 'V1', isMine: false, color: '#fff' });
    expect(el.style.position).toBe('absolute');
    expect(el.style.position).not.toBe('relative');
  });

  it('el raiz mantiene un tamaño fijo: el ancla -50% de MapLibre no debe moverse con el zoom', () => {
    const el = createVehicleMarkerElement({ deviceId: 'V1', isMine: false, color: '#fff' });
    expect(el.style.width).toBe(el.style.height);
    expect(el.style.width).toMatch(/^\d+px$/);
  });

  // si un hijo dejara de ser absolute empujaria el tamaño del raiz y con el, el ancla del marcador
  it('todos los hijos son absolute, asi no alteran el tamaño del raiz', () => {
    const el = createVehicleMarkerElement({ deviceId: 'V1', isMine: false, color: '#fff' });
    const children = (el as unknown as FakeElement).children;
    expect(children.length).toBeGreaterThan(0);
    children.forEach((child) => {
      expect(child.style.position).toBe('absolute');
    });
  });
});
