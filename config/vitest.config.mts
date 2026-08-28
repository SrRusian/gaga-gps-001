//Divide las pruebas en proyectos (unitarias en paralelo e integración secuenciales) para evitar conflictos en la base de datos.
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// este archivo vive en config/, pero los patrones include de abajo son relativos a la raiz del
// repo - sin fijar root explicito, Vitest los resolveria relativos a config/ y no encontraria nada
const repoRoot = path.resolve(import.meta.dirname, '..');

export default defineConfig({
  root: repoRoot,
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'backend/**/*.test.ts',
            'packages/**/*.test.ts',
            'web/packages/**/*.test.ts',
            'app/packages/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['backend/**/*.integration.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          fileParallelism: false,
        },
      },
    ],
  },
});
