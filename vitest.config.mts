import { defineConfig } from 'vitest/config';

// Config raíz para el monorepo - cubre backend y packages/* (Node).
// Las 3 apps web (React) no tienen tests de componentes todavía; si
// se agregan, necesitan un entorno "jsdom" aparte (vía
// "environmentMatchGlobs" o proyectos de Vitest) sin tocar esto.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/backend/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
