import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyHeadingOffset,
  INITIAL_HEADING_OFFSET_STATE,
  loadHeadingOffset,
  persistHeadingOffset,
  updateHeadingOffset,
} from '../../../../../../app/packages/operator-ui/src/headingCalibration';

const MOVING = 10; // m/s, muy por encima del umbral de calibracion
const STOPPED = 0.1;

function fakeLocalStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}

describe('headingCalibration', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = fakeLocalStorage();
  });

  // caso real del usuario: la tableta va montada acostada, girada 90 grados, asi que la brujula
  // apunta 90 grados corrida respecto al frente del vehiculo
  it('aprende un montaje girado 90 grados y deja la flecha apuntando al frente real', () => {
    const state = updateHeadingOffset(INITIAL_HEADING_OFFSET_STATE, 0, 270, MOVING);
    expect(state.offsetDeg).toBe(90);
    expect(applyHeadingOffset(270, state.offsetDeg)).toBe(0);
  });

  it('no aprende nada con el vehiculo detenido: ahi el rumbo GPS no es referencia confiable', () => {
    const state = updateHeadingOffset(INITIAL_HEADING_OFFSET_STATE, 0, 270, STOPPED);
    expect(state.offsetDeg).toBeNull();
  });

  it('resuelve bien el cruce 359 -> 0 sin irse por el lado largo', () => {
    const state = updateHeadingOffset(INITIAL_HEADING_OFFSET_STATE, 10, 350, MOVING);
    expect(state.offsetDeg).toBe(20);
    expect(applyHeadingOffset(350, state.offsetDeg)).toBe(10);
  });

  it('la zona muerta ignora la vibracion de cabina', () => {
    const learned = { offsetDeg: 90 };
    const jittered = updateHeadingOffset(learned, 2, 270, MOVING); // desvio de 2 grados
    expect(jittered.offsetDeg).toBe(90);
  });

  it('sin desfase aprendido la lectura pasa tal cual', () => {
    expect(applyHeadingOffset(123, null)).toBe(123);
  });

  // lo que evita que la flecha apunte mal hasta el primer tramo recto de cada dia
  it('el desfase aprendido sobrevive a reiniciar la app', () => {
    persistHeadingOffset({ offsetDeg: 90 });
    expect(loadHeadingOffset().offsetDeg).toBe(90);
  });

  it('sin nada guardado arranca sin desfase, no en cero', () => {
    expect(loadHeadingOffset().offsetDeg).toBeNull();
  });
});
