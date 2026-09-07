# Tests

Todos los tests del monorepo viven aquí, organizados en tres carpetas según qué necesitan para
correr - ninguno vive junto al código que prueba.

- **`unit/`** - en memoria, con fakes/mocks, sin tocar Postgres ni un servidor real. Replica la
  ruta del archivo que prueba: `tests/unit/backend/src/services/alerts/GeofenceAlertService.test.ts`
  prueba `backend/src/services/alerts/GeofenceAlertService.ts`. Corre con `npm test`.
- **`integration/`** - contra Postgres/PostGIS real, sin arrancar el servidor HTTP. Requiere
  `docker compose up -d postgres` (`npm run test:integration` ya lo hace solo). Ver
  `GeofenceRepository.integration.test.ts`/`DeviceRepository.integration.test.ts` como referencia
  de patrón: crear su propio proyecto/registros de prueba con nombre único
  (`test-algo-${Date.now()}`), limpiar todo en `afterAll`.
- **`e2e/`** - contra el backend completo corriendo de verdad (`npm run dev` o
  `docker compose up -d --build`), hablando por HTTP igual que lo haría el frontend. Requiere que
  el stack ya esté arriba (`npm run test:e2e` lo levanta solo con `pretest:e2e`). Usar para flujos
  que de verdad necesitan el proceso completo (ej. GDAL procesando un archivo real) - no para todo
  lo que ya puede probarse más rápido a nivel de repositorio en `integration/`.

## Agregar un test nuevo

1. Decide qué tipo es (ver arriba).
2. Crea el archivo en `tests/<tipo>/`, replicando la ruta del archivo original si es `unit/`
   (ej. `web/packages/map-core/src/geometry.ts` → `tests/unit/web/packages/map-core/src/geometry.test.ts`).
3. Importa el archivo real con una ruta relativa hacia atrás hasta la raíz del repo y de ahí a la
   ruta real (ej. desde `tests/unit/backend/src/utils/` hacia `backend/src/utils/algo` son 5
   niveles: `../../../../../backend/src/utils/algo`). No hace falta memorizarlo - cualquier editor
   autocompleta la ruta correcta al escribir el import.

No hace falta tocar `config/vitest.config.mts` - los tres proyectos (`unit`/`integration`/`e2e`) ya
apuntan a `tests/unit/**`, `tests/integration/**` y `tests/e2e/**` respectivamente, sin importar el
paquete de origen.

## Correr todo antes de un push

```bash
npm run test:all
```

Corre las tres suites en orden (`test` → `test:integration` → `test:e2e`) y se detiene en la
primera que falle. Si todo pasa, es seguro subir los cambios.
