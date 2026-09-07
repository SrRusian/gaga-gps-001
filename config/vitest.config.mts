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
          // todos los tests unitarios viven en tests/unit/, replicando la ruta del archivo que
          // prueban (tests/unit/backend/src/services/alerts/X.test.ts prueba
          // backend/src/services/alerts/X.ts) - ninguno co-ubicado junto al código real
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
      {
        test: {
          // pruebas de integracion/e2e viven centralizadas en tests/ (no junto al codigo como las
          // unitarias) - prueban flujos/endpoints completos, no un archivo puntual, asi que no les
          // pertenecen a un solo modulo de backend/src
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          fileParallelism: false,
        },
      },
      {
        test: {
          // requiere el stack completo corriendo de verdad (npm run dev o docker compose up -d
          // --build) - habla por HTTP contra localhost:3001, no contra Postgres/repos directo como
          // "integration". Timeout largo a proposito: GDAL procesando una ortofoto real (decenas
          // de MB) tarda minutos, no segundos.
          name: 'e2e',
          environment: 'node',
          include: ['tests/e2e/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          fileParallelism: false,
          testTimeout: 15 * 60 * 1000,
        },
      },
    ],
  },
});
