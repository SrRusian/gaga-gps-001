# GAGA-GPS v2.0

Sistema de Geolocalización y Control de Flota en Tiempo Real para
operación minera - GAGA.

Sistema **propio** de telemetría GPS - **sin Traccar Server** como
intermediario. Las tabletas siguen usando la app **Traccar Client**
sin modificaciones (protocolo OsmAnd); solo cambia la URL del
servidor, que ahora apunta directamente a este backend Node.js.

> Este documento está pensado para que cualquier persona del equipo
> -nueva o veterana- entienda el proyecto completo: qué hace, cómo
> está construido, cómo instalarlo, configurarlo, desplegarlo y
> resolver problemas comunes.

---

## Tabla de contenido

1. [Visión general](#visión-general)
2. [Arquitectura](#arquitectura)
3. [Autenticación y roles](#autenticación-y-roles)
   - [Turnos de operador y vinculación de dispositivo](#turnos-de-operador-y-vinculación-de-dispositivo)
4. [Stack tecnológico](#stack-tecnológico)
5. [Migración a monorepo TypeScript/React (completada)](#migración-a-monorepo-typescriptreact-completada)
   - [Tests del backend](#tests-del-backend)
   - [Cómo agregar un módulo nuevo](#cómo-agregar-un-módulo-nuevo)
6. [Estructura del proyecto](#estructura-del-proyecto)
7. [Modelo de datos](#modelo-de-datos)
8. [Instalación y despliegue](#instalación-y-despliegue)
   - [Caddy: HTTPS y dominio](#caddy-https-y-dominio)
   - [Aislamiento de contenedores](#aislamiento-de-contenedores--qué-toca-el-host-y-qué-no)
   - [Persistencia de datos](#persistencia-de-datos--instalación-limpia-vs-actualización-vs-borrado-total)
   - [Importador de mapas satelitales](#importador-de-mapas-satelitales-tiftfw--mbtiles)
9. [Variables de entorno](#variables-de-entorno)
10. [Configurar Traccar Client en las tabletas](#configurar-traccar-client-en-las-tabletas)
11. [Referencia de la API](#referencia-de-la-api)
12. [Eventos de Socket.io en tiempo real](#eventos-de-socketio-en-tiempo-real)
13. [Módulos de seguridad (RF-ALR)](#módulos-de-seguridad-rf-alr)
    - [Filtro de posiciones GPS (anti-teletransporte RTK/NTRIP)](#filtro-de-posiciones-gps-anti-teletransporte-rtkntrip)
    - [Estimación de velocidad](#estimación-de-velocidad)
    - [Radar de proximidad fuera de ruta](#radar-de-proximidad-fuera-de-ruta)
14. [Seguridad del backend](#seguridad-del-backend)
15. [Retención y compresión de datos](#retención-y-compresión-de-datos)
16. [Panel de administración](#panel-de-administración)
17. [Panel de Operador y Supervisor](#panel-de-operador-y-supervisor)
18. [Acceso directo a PostgreSQL y Redis](#acceso-directo-a-postgresql-y-redis)
19. [Solución de problemas comunes](#solución-de-problemas-comunes)
20. [Limitaciones conocidas / trabajo futuro](#limitaciones-conocidas--trabajo-futuro)

---

## Visión general

GAGA-GPS rastrea en tiempo real una flota de vehículos/maquinaria
dentro de una operación minera, usando tabletas Android con la app
**Traccar Client** como dispositivos GPS. El backend recibe esa
telemetría directamente (sin pasar por un servidor Traccar), la
persiste, evalúa varias reglas de seguridad automáticas (geocercas,
anticolisión, pérdida de señal, aproximación a equipo pesado,
parada preventiva colectiva) y distribuye todo en tiempo real a
tres interfaces web, todas detrás de un **login único** (ver
[Autenticación y roles](#autenticación-y-roles)):

- **Operador** (`/operator`) - vista en campo, en la tableta del
  vehículo: mapa, alertas, mi posición/velocidad.
- **Supervisor** (`/supervisor`) - vista de sala de control: toda
  la flota, alertas activas, botón de parada preventiva colectiva.
- **Admin** (`/admin`) - gestión: dispositivos, geocercas, equipo
  estático, usuarios, historial/reportes, estado del sistema.

## Arquitectura

```
Tableta (Traccar Client, protocolo OsmAnd)
        │ GET o POST /gps?id=...&lat=...&lon=...
        │ (o los mismos parámetros en el body, según versión de la app)
        ▼
apps/backend/src/api/routes/telemetry.routes.ts
        │ Valida clave compartida (opcional), parámetros, rango lat/lon
        ▼
apps/backend/src/services/telemetry/PositionProcessor.ts
        │ 1. Auto-registra el dispositivo si es nuevo (DeviceManager)
        │ 2. Persiste en PostgreSQL/TimescaleDB (PositionRepository)
        │ 3. Actualiza el estado en memoria (FleetStateManager → Redis)
        │ 4. Evalúa módulos de seguridad (geocercas, colisión, señal, equipo)
        │ 5. Distribuye vía Socket.io (FleetSocketServer)
        ▼
UI Operador / UI Supervisor / UI Admin (navegador)
```

No existe ya ningún componente Traccar Server, WebSocket externo ni
polling - todo el procesamiento ocurre de forma síncrona en el
momento en que llega la petición HTTP.

## Autenticación y roles

Todos los usuarios (admin, supervisor, operator, y cualquier rol que
se agregue a futuro) tienen cuenta con correo y contraseña, y pasan
por un **login único** dentro de la misma SPA (`apps/web-app`,
`features/auth/LoginScreen.tsx`), servida en la raíz del dominio
(`app.gaga-maquinaria.com/`). No existen logins separados por rol -
antes Admin y Operador tenían cada uno su propia pantalla de login
(llamando al mismo `/api/auth/login` por separado) y Supervisor no
tenía cuenta en absoluto (pantalla de sala de control sin dueño).
Ahora:

```
app.gaga-maquinaria.com/           (features/auth/LoginScreen.tsx)
        │ POST /api/auth/login  →  { token, user: { role } }
        │ guarda la sesión en localStorage
        ▼
navigate(`/${role}`)   ← React Router, sin recargar la página
        │
        ├─ role="admin"      → /admin       (features/admin,      lazy)
        ├─ role="supervisor" → /supervisor  (features/supervisor, lazy)
        └─ role="operator"   → /operator    (features/operator,   lazy)
```

Dos roles más reutilizan estos mismos paneles con distinto alcance -
`project_manager` entra a `/encargado` (mismo componente `AdminApp`
que Admin, misma sección `features/admin` - dos rutas, no dos copias,
solo para que la URL refleje con qué rol se entró) y `project_supervisor`
entra a `/supervisor` (como Supervisor, pero solo de su turno) - ver
[Multi-tenencia por proyecto](#multi-tenencia-por-proyecto) más abajo.
`resolveRolePath()` (`packages/client/src/roles.ts`) es el único lugar
donde "rol" y "ruta de panel" se desacoplan.

**Una sola SPA con React Router, no 4 aplicaciones separadas** - el
login y las 3 vistas por rol viven en `apps/web-app`, organizada por
feature (`src/features/{auth,admin,supervisor,operator}/`). Antes
cada rol era un proyecto Vite independiente (`web-gateway`,
`web-admin`, `web-supervisor`, `web-operator`), cada uno con su
propio `package.json`/`tsconfig.json`/`vite.config.ts`/`node_modules`
- viable con 3-4 apps, pero fricción innecesaria de mantenimiento con
un solo desarrollador. Al unificarlas, Express también se simplificó:
en vez de 4 `express.static` en subrutas distintas, ahora sirve un
único build (`apps/backend/src/app.ts`) con un _fallback_ de SPA al
final (cualquier ruta que no sea un archivo real ni `/api`, `/gps`,
`/tiles`, `/health` o `/socket.io` responde `index.html`, y React
Router decide qué mostrar del lado del cliente).

- **`ProtectedRoute`** (`features/auth/ProtectedRoute.tsx`) reemplaza
  lo que antes era `useRoleGuard` repetido en cada app: valida que
  haya sesión y que el rol coincida con la ruta (`/admin` exige
  `role==="admin"`, etc.) - si no, `<Navigate to="/" replace />` sin
  recargar la página. Antes una sesión inválida hacía
  `window.location.href = '/'` (recarga completa); ahora es una
  redirección de React Router, instantánea.
- **Code-splitting por rol con `React.lazy()` + `Suspense`**
  (`apps/web-app/src/App.tsx`) - cada feature de rol es un
  `import()` dinámico, así que Vite genera un chunk JS/CSS separado
  por rol. Un operador que entra desde su tableta descarga el chunk
  de login + el de `/operator` (~11 KB) - el código de Admin
  (tablas, `@mapbox/mapbox-gl-draw` para geocercas, ~93 KB) **no se
  descarga** a menos que ese usuario tenga rol `admin`. Verificado
  con `vite build`: `AdminApp-*.js`, `SupervisorApp-*.js` y
  `OperatorApp-*.js` son archivos completamente separados. El único
  chunk pesado compartido entre los 3 es MapLibre GL (~1 MB) - lo
  usan los 3 roles para renderizar mapas, así que compartirlo es lo
  correcto, no una fuga de código de un rol a otro.
- **Los componentes visuales compartidos siguen en `packages/ui` y
  `packages/map-core`** (Button, VehicleCard, StatCard,
  `useSatelliteLayers`, `useGeofenceLayer`, etc.) - eso no cambió con
  esta reestructuración; unificar las 4 apps en una sola solo afecta
  cómo se sirven y navegan, no dónde vive la lógica reutilizable.
  `apps/web-app/src/shared/` queda reservado para algo que en algún
  momento sea puramente de esta app (no publicable como paquete) y
  se repita entre features - hoy no hay nada así, por eso está vacío.
- **`npm audit` marca `react-router-dom` con 2 vulnerabilidades
  "high"** (CSRF bypass en modo RSC/`action` de los _data routers_ -
  [GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2)).
  No aplica a este proyecto: se usa el modo declarativo clásico
  (`<BrowserRouter>`/`<Routes>`/`<Route>`), sin `createBrowserRouter`,
  sin `action`/`loader` ni React Server Components - la superficie
  vulnerable no está en uso. Bajar de versión para "resolver" la
  alerta perdería parches reales a cambio de cero reducción de riesgo
  real aquí, así que se mantiene la última versión estable.

**Roles genéricos, no una lista fija**: `users.role` es un `VARCHAR`
libre en `db/migrations/001_init.sql`, sin `CHECK` que limite los
valores posibles (versiones anteriores del schema sí lo tenían), y el
tipo `UserRole` en el backend es `string`, no una unión cerrada.
Agregar un rol nuevo (ej. `dispatcher`, `technician`) no requiere
migración ni cambios de tipo - solo: (1) agregar la opción al
`<select>` de Admin → Usuarios, (2) decidir qué rutas del backend
debe poder usar con `requireRole('nuevo_rol', ...)` en `app.ts`, y
(3) si necesita una vista propia, una carpeta más en
`src/features/` + una `<Route>` protegida más en `App.tsx`.

**Duración del token por rol** (decidida por el backend, no por lo
que mande el cliente): operador usa `OPERATOR_JWT_EXPIRES_IN` (30
días por defecto - la tableta queda logueada varios días sin forzar
re-login constante); el resto usa `JWT_EXPIRES_IN` (8h). Ver
`apps/backend/src/api/routes/auth.routes.ts`.

**Sockets también requieren login** - antes cualquiera que alcanzara
el servidor podía abrir una conexión de Socket.io y recibir la
posición en vivo de toda la flota sin autenticarse (Supervisor y
Operador no mandaban token). Ahora `io.use(buildSocketAuthMiddleware(...))`
valida el JWT en el _handshake_ de conexión (`auth: { token }`,
adjuntado automáticamente por `createSocket()` en `packages/client`)
- una conexión sin token o con uno inválido se rechaza antes de
hidratar nada. `apps/backend/test-client.js` (la herramienta manual
de diagnóstico) hace login por HTTP primero para poder conectarse.

**`/api/fleet/stop` y `/api/fleet/resume`** (activar/desactivar la
parada preventiva colectiva) pasaron de ser rutas completamente
abiertas a requerir JWT + `requireRole('supervisor', 'admin')` - es
la acción de seguridad más crítica del sistema y antes cualquiera
con la URL podía dispararla. `GET /api/fleet/state` y
`/api/fleet/stop/status` (solo lectura) siguen sin requerir login.

### Turnos de operador y vinculación de dispositivo

Separa dos identidades que no deben mezclarse - el mismo patrón que
usan sistemas de flotillas profesionales (Samsara, Geotab):

- **Identidad del vehículo/tableta** - fija por configuración de
  kiosco, no por login. Se resuelve leyendo `?device=X` en la URL
  del panel Operador (configurado una sola vez por el técnico que
  instala la tableta, p. ej. como acceso directo/kiosco en Android),
  con fallback a `localStorage`. Si no hay ninguno configurado, se
  muestra una pantalla de configuración que **valida contra el
  sistema** (`GET /api/devices/lookup/:uniqueId`) antes de continuar
  - evita que un ID inventado o mal tecleado avance hasta el login,
  y advierte (sin bloquear) si ese dispositivo ya tiene un turno
  activo con otro operador, para detectar identificadores duplicados
  entre tabletas.
- **Identidad del operador** - resuelta por el login único (no pide
  credenciales otra vez aquí). Una vez identificado,
  si el dispositivo no tiene ya un turno activo, se le ofrece
  "Iniciar turno" - un solo clic, sin formulario - que abre el
  registro en `operator_sessions`. Un mismo operador puede iniciar
  turno en máquinas distintas en momentos distintos - el sistema
  lleva el registro por separado, permitiendo reportar tanto
  "¿quién operó este vehículo?" como "¿cuántas horas trabajó esta
  persona, en qué máquinas?" (`GET /api/operator-sessions/report`).

**Persistencia del turno**: como se explica arriba, el token de un
operador dura `OPERATOR_JWT_EXPIRES_IN` (30 días por defecto) para no
forzar re-login constante. Mientras la pestaña siga abierta, el panel
Operador envía un heartbeat cada 5 minutos
(`POST /api/operator-sessions/:id/heartbeat`). Si un turno deja de
recibir heartbeats por más de `OPERATOR_SESSION_MAX_IDLE_DAYS` (7
días por defecto - tableta perdida, app cerrada sin cerrar turno), el
backend lo cierra automáticamente en segundo plano.

## Stack tecnológico

| Componente             | Tecnología                                      | Uso                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend                | Node.js 22 + Express 5 + **TypeScript**         | API REST, receptor de telemetría, lógica de seguridad                                                                                                                |
| Tests                  | Vitest                                          | Caracterización de los 5 módulos de seguridad - ver [Tests del backend](#tests-del-backend)                                                                          |
| Tiempo real            | Socket.io 4                                     | Distribución de posiciones/alertas a las UIs                                                                                                                         |
| Base de datos          | PostgreSQL 16 + TimescaleDB                     | Dispositivos, geocercas, equipo, usuarios, histórico de posiciones (hypertable)                                                                                      |
| Extensión espacial     | PostGIS                                         | Instalada pero **no utilizada actualmente** - los cálculos de distancia usan Haversine en JS (ver [Limitaciones conocidas](#limitaciones-conocidas--trabajo-futuro)) |
| Caché / estado en vivo | Redis 7                                         | Última posición conocida de cada dispositivo (no guarda histórico)                                                                                                   |
| Autenticación          | JWT (jsonwebtoken) + bcryptjs                   | Login del panel admin, con revalidación de usuario activo en cada request                                                                                            |
| Mapas                  | MapLibre GL + MBTiles (better-sqlite3)          | Renderizado de mapas offline en las tabletas                                                                                                                         |
| Contenerización        | Docker + Docker Compose                         | Stack completo (Caddy + backend + UIs + PostgreSQL + Redis) con un solo `docker-compose.yml`, mismo para desarrollo y producción                                     |
| Reverse proxy HTTPS    | Caddy 2.11                                      | Terminación HTTPS automática y proxy inverso hacia el backend                                                                                                        |
| Cliente GPS            | Traccar Client (app de terceros, sin modificar) | Corre en las tabletas, protocolo OsmAnd                                                                                                                              |

## Migración a monorepo TypeScript/React (completada)

El backend y las 3 UIs (`ui-operator`, `ui-supervisor`, `ui-admin`)
nacieron como JavaScript plano sin build step - funcional, pero con
una duplicación real de código entre paneles (la lógica de capas de
mapa satelital y de renderizado de geocercas estaba copiada **4
veces**: Operador, Supervisor, y dos instancias de mapa distintas
dentro de Admin - la causa raíz de un bug de orden de capas que se
corrigió a mano en las 4 copias antes de arrancar esta migración). El
proyecto se migró a un monorepo con TypeScript de punta a punta y
piezas compartidas, para eliminar esa duplicación de raíz y facilitar
agregar funcionalidad nueva (incluida una futura app móvil nativa,
fuera de esta ronda) sin tener que tocar el mismo código 4 veces.

**Stack: antes vs. ahora**

| Capa                         | Antes                                                                                       | Ahora                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Backend                      | Node.js 22 + Express 5, JavaScript (CommonJS), sin tests                                    | **TypeScript** en el mismo lugar (sin reorganizar carpetas), 71 tests de Vitest cubriendo los 5 módulos de seguridad |
| UI Operador/Supervisor/Admin | 3 archivos HTML únicos, JS inline, sin build, MapLibre GL + Socket.io por `<script>` de CDN | 3 apps **React + TypeScript** (Vite), construidas con piezas compartidas en vez de copiar/pegar - ver nota más abajo |
| Código compartido            | Ninguno - cada panel repetía su propia copia                                                | Paquetes de un monorepo (`packages/shared-types`, `packages/client`, `packages/map-core`, `packages/ui`)             |
| Despliegue                   | `docker compose up -d --build`, un solo comando                                             | **Sin cambios** - sigue siendo el mismo comando único; solo cambió qué construye el `Dockerfile` por dentro          |

> **Nota (posterior a esta fase):** las 3 apps React de esta tabla
> (más una 4ª, `web-gateway`, agregada después para el login único)
> se consolidaron más adelante en una sola SPA con React Router y
> code-splitting por rol - ver [Autenticación y roles](#autenticación-y-roles)
> para la arquitectura de frontend **actual**. El resto de esta
> sección (backend a TypeScript, paquetes compartidos, decisiones de
> la migración original) sigue vigente tal cual.

**Estructura** (monorepo con `npm workspaces` - sin Turborepo/Nx ni
otras herramientas de monorepo grandes: no se justifican para un
equipo de este tamaño) - ver el árbol completo en
[Estructura del proyecto](#estructura-del-proyecto).

**Decisiones deliberadas de esta migración** (para que quien retome
el trabajo no las reabra sin razón):

- El backend se convirtió a TypeScript **sin reorganizar carpetas** -
  al empezar no había ningún test que protegiera mover ~30 archivos
  de sitio a la vez que se les cambiaba de lenguaje; doblar el riesgo
  no se justificaba en un backend de 11 rutas que ya se lee de arriba
  a abajo sin problema. Si algún día hace falta, es barato hacerlo
  después, con TypeScript ya marcando cualquier import roto.
- Sin framework de DI, sin inyectar el pool de PostgreSQL en cada
  repositorio - el patrón original (composition root manual en
  `app.ts`) se mantuvo, solo tipado.
- ~~Sin React Router en las 3 apps - Admin cambia de "sección" con
  estado de React, no con URLs, igual que antes con JS puro.~~
  **Revertido después**: al consolidar las 4 apps en una sola SPA sí
  se agregó React Router - con una sola app y 3 roles en la misma
  URL base, sí hacía falta enrutamiento real (`/admin`, `/supervisor`,
  `/operator` + `ProtectedRoute`). Admin sigue sin URLs por sección
  internamente (`/admin` es una sola ruta; el cambio de "pestaña" en
  el panel sigue siendo estado de React) - ver
  [Autenticación y roles](#autenticación-y-roles).
- Los `packages/*` se consumen como TypeScript fuente, sin build
  propio - Vite y `tsc` los compilan al vuelo vía los symlinks de
  `npm workspaces`.
- Migración **en el sitio** (sin sistema paralelo viejo+nuevo), con
  una excepción: la ingesta de telemetría (`/gps`) habla con tabletas
  reales (Traccar Client) que no se pueden re-desplegar a demanda, así
  que ese único camino se verificó con un chequeo de "antes/después"
  usando `apps/backend/test-client.js` en cada paso que lo tocó.
- Se aprovechó el camino para un puñado de mejoras chicas de bajo
  riesgo (autorizadas explícitamente, no un cambio de alcance): env
  tipada con `zod` en vez de un `validateEnv()` ad-hoc, simplificación
  de una comparación redundante que TypeScript probó inalcanzable en
  `GeofenceAlertService`, unificación del color de "otro vehículo"
  en Supervisor (antes solo lo tenía Operador), y actualización de
  `maplibre-gl` (`^4.7.1` → `^5.24.0` en las 3 apps + `map-core`) para
  eliminar dos paquetes de tipos transitivos que npm marca deprecados
  (`@types/mapbox__point-geometry`/`@types/mapbox__vector-tile` - las
  versiones nuevas de `@mapbox/point-geometry`/`@mapbox/vector-tile`
  ya traen sus propios tipos). Se evitó saltar directo a MapLibre 6.x
  (recién estabilizado al momento de este cambio) para no combinar dos
  saltos de versión mayor en un solo cambio; la API que usa este
  proyecto (`Map`, `Marker`, `Popup`, `GeoJSONSource`,
  `StyleSpecification`) no cambió entre 4.x y 5.x - verificado con
  `tsc`/`vite build` limpios en las 3 apps y una reconstrucción
  completa de la imagen Docker.
- `tsconfig.base.json` pasó de `"module": "CommonJS"` +
  `"moduleResolution": "Node"` (alias de `"node10"`, marcado obsoleto
  por el propio compilador - algunos editores ya lo muestran como
  error: _"Option 'moduleResolution=node10' is deprecated and will
  stop functioning in TypeScript 7.0"_) a
  `"module"`/`"moduleResolution": "NodeNext"`, el valor moderno
  recomendado para proyectos Node.js. No cambia nada en la práctica
  porque todo el código (`apps/backend` + los 4 `packages/*`) es
  CommonJS puro (`"type": "commonjs"` en cada `package.json`, sin
  ningún `.mts`/`.cts`) - confirmado comparando byte a byte el
  `dist/` compilado del backend antes y después del cambio (idéntico)
  y con `tsc --noEmit` limpio en los 4 paquetes + build completo +
  Docker reconstruido. Los 3 `apps/web-*` no se tocaron: ya usaban
  `"moduleResolution": "Bundler"` explícito (el valor correcto para
  proyectos Vite), nunca dependieron del default heredado.

**Roadmap** (cada fase se verificó en vivo contra Docker antes de
pasar a la siguiente):

- [x] Fase 0 - Monorepo (`npm workspaces`), relocación de `backend/`
      y `ui-*/` a `apps/`, esqueleto de `packages/*`.
- [x] Fase 1 - Backend a TypeScript. 71 tests de caracterización
      (Vitest) capturados contra el código original antes de convertir
      cada módulo de seguridad, más un chequeo dorado de telemetría
      (`/gps` → `positions` → `fleet:update`) verificado antes/después.
      `tsc`/ESLint limpios, imagen Docker reconstruida y verificada en
      vivo (health, login, telemetría con aceptación/rechazo RTK,
      broadcast de socket). Ver [Tests del backend](#tests-del-backend)
      y el hallazgo documentado en
      [Limitaciones conocidas](#limitaciones-conocidas--trabajo-futuro).
- [x] Fase 2 - Paquetes compartidos del frontend: `shared-types`
      (contrato único de tipos + eventos de Socket.io),
      `client` (fetch + Socket.io tipados), `map-core` (única
      implementación de capas satelitales y geocercas - reemplaza las
      4 copias), `ui` (componentes visuales + tokens de color).
- [x] Fase 3 - Supervisor → Operador → Admin migrados a Vite+React+TS,
      en ese orden (de la más chica a la más grande), cada una
      verificada en vivo contra Docker antes de pasar a la siguiente.
- [x] Fase 4 - `apps/backend/Dockerfile` reescrito como build de
      workspace completo: etapa `deps` instala con todos los
      `package.json` del monorepo, etapa `build` corre `tsc` (backend) + `vite build` (las 3 apps) vía `npm run build` de la raíz,
      etapa `runtime` sirve el backend compilado y los `dist/` de cada
      app en los mismos mount points de `express.static` de siempre.
      `docker-compose.yml`/`Caddyfile` sin cambios - Caddy solo hace
      reverse proxy, ajeno a cómo se construyó la imagen por dentro.
      Verificado en Docker: health, las 3 UIs sirviendo con sus assets
      en la subruta correcta, login admin, telemetría con clave
      compartida, CRUD de dispositivos.
- [x] Fase 5 - Cierre: este README es la fuente de verdad del estado
      final (ver también [Cómo agregar un módulo nuevo](#cómo-agregar-un-módulo-nuevo)).

### Tests del backend

`npm test` desde la raíz corre Vitest sobre todo el monorepo (hoy,
solo `apps/backend` tiene tests reales). Cubre específicamente los 5
módulos de seguridad (RF-ALR) + `geometry.ts` + `PositionFilterService`
- 71 tests en 7 archivos, uno por módulo, colocados junto al código
que prueban (`*.test.ts`). No es cobertura exhaustiva de todo el
backend a propósito - son tests de **caracterización**: existen para
congelar el comportamiento exacto de la lógica de seguridad antes de
tocarla, no para perseguir un porcentaje de cobertura.

```bash
npm test              # una vez
npm run test:watch    # modo watch
npm run lint          # ESLint sobre todo el monorepo (config compartida en eslint.config.js)
```

Además del test suite, la ingesta de telemetría (`/gps`) se verificó
con un chequeo dorado manual: una secuencia conocida de posiciones
(incluyendo un salto físicamente imposible que el filtro RTK/NTRIP
debe rechazar) enviada contra el backend real en Docker, comparando
las filas resultantes en `positions` y los eventos `fleet:update`
antes y después de la conversión a TypeScript.

### Cómo agregar un módulo nuevo

Guía corta para el caso de uso que motivó esta migración -
agregar funcionalidad sin duplicar código entre paneles ni
sorpresas de tipos entre backend y frontend.

**Un endpoint/recurso nuevo en el backend** (p. ej. un módulo de
seguridad más):

1. Repositorio en `apps/backend/src/repositories/` (acceso a
   PostgreSQL, sigue el patrón de los existentes - sin ORM, SQL
   directo con `pg`).
2. Servicio en `apps/backend/src/services/` con la lógica de negocio.
   Si emite eventos en vivo, agrega el evento a
   `packages/shared-types/src/socket-events.ts`
   (`ServerToClientEvents`) - así el tipo del payload queda
   compartido entre el `emit()` del backend y el `.on()` del
   frontend, sin listas paralelas que se desincronicen.
3. Ruta en `apps/backend/src/api/routes/`, registrada en `app.ts`.
4. Tipos de dominio nuevos (si aplica) van directo en
   `packages/shared-types/src/` - nunca se definen localmente en el
   backend "para mover después"; es la fuente de verdad que consume
   tanto el backend como `apps/web-app`.
5. Tests de caracterización si el módulo es de seguridad (ver
   [Tests del backend](#tests-del-backend)) - capturan el
   comportamiento antes de que alguien lo toque después.

**Una pantalla/sección nueva en Operador, Supervisor o Admin**:

1. Si la lógica es de mapa (nueva capa, nuevo modo de visualización)
   o de renderizado de geocercas, va en `packages/map-core/src/` como
   un hook - nunca directo en el componente de una sola feature, para
   no volver a los 4 copy-paste que motivaron la migración original.
2. Si es un componente visual reutilizable (botón, tarjeta, badge de
   estado), va en `packages/ui/src/`.
3. Las llamadas HTTP/Socket.io usan `packages/client/src/` - no
   `fetch()`/`io()` sueltos en el componente.
4. El componente de la pantalla en sí vive en
   `apps/web-app/src/features/{admin,supervisor,operator}/`,
   específico de ese rol - no todo tiene que ser compartido, solo lo
   que de verdad se repite entre roles. Si de verdad es genérico pero
   demasiado específico de esta app para ser un paquete publicable,
   va en `apps/web-app/src/shared/`.
5. Si la sección es nueva dentro de Admin (como Dashboard, Geocercas,
   etc.), sigue el patrón de `features/admin/sections/` - un
   componente por sección, registrado en el `SECTIONS` de
   `AdminApp.tsx`.

**Un rol nuevo del todo** (ej. `dispatcher`): ver el detalle completo
en [Autenticación y roles](#autenticación-y-roles) - en resumen, una
carpeta `features/dispatcher/` con su propio componente lazy-cargado,
una `<Route>` protegida más en `App.tsx`, la opción en el `<select>`
de Admin → Usuarios, y decidir qué rutas del backend puede usar con
`requireRole('dispatcher', ...)`. No hace falta una app ni un
`package.json` nuevo - el code-splitting por `React.lazy()` ya
garantiza que ese código no se descargue en dispositivos de otros
roles.

## Estructura del proyecto

Monorepo con `npm workspaces` - un solo `package-lock.json` en la
raíz, un solo `docker compose up -d --build` que construye backend +
la SPA en una sola imagen (ver [Autenticación y roles](#autenticación-y-roles)
para el porqué de esta estructura - 1 app en vez de 4 - y las
decisiones detrás):

```
gaga-gps-001/
├── apps/
│   ├── backend/
│   │   ├── Dockerfile              # build multi-stage: tsc + vite build → imagen runtime
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── app.ts              # entry point - ensambla todo, sirve la SPA + fallback de rutas
│   │       ├── config/              # pool de PostgreSQL, cliente Redis, env (validado con zod)
│   │       │   └── loadEnv.ts        # carga siempre el .env de la raíz, sin importar el cwd del proceso
│   │       ├── repositories/        # acceso a datos (CRUD PostgreSQL)
│   │       ├── services/
│   │       │   ├── telemetry/       # PositionProcessor, PositionFilterService, DeviceManager, FleetStateManager
│   │       │   ├── alerts/          # 4 de los 5 módulos de seguridad (no se modifican) - el 5º (equipo estático) vive en static_equipment/
│   │       │   ├── static_equipment/ # gestión de equipo estático
│   │       │   └── maps/            # pipeline de imágenes georreferenciadas → MBTiles
│   │       ├── sockets/              # FleetSocketServer (Socket.io, eventos tipados desde shared-types)
│   │       ├── api/
│   │       │   ├── routes/           # un archivo por recurso (ver tabla de endpoints)
│   │       │   └── middleware/       # auth (JWT + Socket.io), rate limiting, logger
│   │       ├── scripts/              # seed-admin.ts
│   │       └── utils/                # geometry.ts, geoFormats.ts (funciones puras)
│   │
│   └── web-app/                      # Vite + React + TS - la única SPA (login + Admin + Supervisor + Operador)
│       ├── vite.config.ts            # base: '/' - una sola app en la raíz, sin subrutas por Vite
│       └── src/
│           ├── main.tsx, App.tsx     # BrowserRouter + rutas protegidas + React.lazy() por rol
│           ├── index.css             # reset global mínimo - cada feature define su propio layout raíz
│           ├── shared/                # componentes/hooks puramente de esta app (hoy vacío - ver nota abajo)
│           └── features/
│               ├── auth/              # LoginScreen (login único) + ProtectedRoute
│               ├── admin/             # AdminApp + sections/ (Dashboard, Reportes, Sistema - Historial vive dentro de Dashboard como modo, no como sección propia)
│               ├── supervisor/        # SupervisorApp - sala de control
│               └── operator/          # OperatorApp - vista en campo + device binding + turnos
│
├── packages/
│   ├── shared-types/                # Device, Geofence, Position, FleetState, Alert*, eventos de Socket.io - contrato único backend↔frontend
│   ├── client/                      # client/http.ts (fetch tipado) + client/socket.ts (Socket.io tipado) + client/session.ts (sesión compartida)
│   ├── map-core/                    # única implementación de sync de capa satelital (useSatelliteLayers) y render de geocercas (useGeofenceLayer)
│   └── ui/                          # Button, AlertBanner, VehicleCard, MapModeSelector, StatCard, tokens de color
│   (los 4 se consumen como TypeScript fuente, sin build propio - Vite/tsc los compilan al vuelo vía los symlinks de npm workspaces; son el nivel de reuso "entre proyectos", mientras que src/shared/ de web-app sería el nivel "dentro de esta app" si algún día hace falta)
│
├── db/
│   └── migrations/
│       └── 001_init.sql             # schema completo en un solo archivo, se aplica solo en Postgres nuevo (ver nota abajo)
│
├── TEST-FILES/                      # imágenes de muestra para el pipeline de mapas (no versionado)
│
├── caddy/
│   └── Caddyfile                    # configuración HTTPS/proxy
│
├── package.json                     # workspaces: ["apps/*", "packages/*"] - scripts build/test/lint a nivel monorepo
├── tsconfig.base.json                # config TS compartida (target/module/strict)
├── eslint.config.js                  # ESLint flat config compartido (todo el monorepo)
├── docker-compose.yml                # stack completo (Caddy + backend + Postgres + Redis) - dev y producción
├── .dockerignore                     # contexto de build = raíz del repo (ver apps/backend/Dockerfile)
├── .env.example                      # única plantilla de variables - copiar a .env y editar
└── README.md
```

## Modelo de datos

Definido en `db/migrations/` (se aplica automáticamente, en orden,
la primera vez que se crea el volumen de PostgreSQL).

| Tabla              | Propósito                                                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devices`          | Dispositivos/tabletas - `unique_id` es el identificador que configuras en Traccar Client                                                                                                      |
| `positions`        | Hypertable de TimescaleDB - una fila por cada posición GPS recibida, particionada por `fix_time`                                                                                              |
| `geofences`        | Geocercas - círculo, polígono o polilínea/corredor (ver [Geocercas avanzadas](#geocercas-avanzadas-círculo-polígono-ruta)) - tipo `warning` (amarilla) o `danger` (roja)                      |
| `geofence_events`  | Auditoría de entradas/salidas de geocercas                                                                                                                                                    |
| `static_equipment` | Equipo estático (palas, excavadoras) con radio de giro y de seguridad - `linked_device_id` (nullable, único) vincula opcionalmente la tableta montada en la máquina                           |
| `users`            | Cuentas de todos los roles (login único) - `role` es texto libre, no una lista fija (ver [Autenticación y roles](#autenticación-y-roles))                                                     |
| `maps`             | Mapas satelitales/drone importados (TIF/TFW → MBTiles) - metadata del pipeline, no el archivo en sí (ver [Importador de mapas satelitales](#importador-de-mapas-satelitales-tiftfw--mbtiles)). Tiene `project_id` (nullable) - un mapa pertenece a un proyecto, igual que `geofences`/`static_equipment` |

## Geocercas avanzadas (círculo, polígono, ruta)

Además del círculo original (centro + radio), el sistema soporta:

- **Polígono** - zona autorizada de forma arbitraria, dibujada
  directamente en el mapa del panel Admin.
- **Polilínea / corredor** - ruta autorizada con un ancho definido
  a cada lado (`corridorWidthMeters`); útil para marcar el camino
  por el que debe circular la maquinaria.

Todas se evalúan en tiempo real con la misma lógica de alertas
(`GeofenceAlertService` + `apps/backend/src/utils/geometry.ts`, sin
depender de PostGIS) y cada entrada/salida queda registrada en
`geofence_events` para auditoría/reportes.

**Panel Admin → Dashboard** (ver
[Multi-tenencia por proyecto](#multi-tenencia-por-proyecto) - crear
una geocerca vive en un panel flotante sobre el mapa grande del
alcance elegido, no en una pestaña separada ni en un modal que tape el
mapa, porque necesita interacción real con él):

- Botón "+ Nueva geocerca" **dentro del overlay "Geocercas"** (no
  flota sobre el mapa - esa segunda entrada era redundante con esta y
  se quitó) - selector "Forma" para elegir círculo/polígono/ruta antes
  de dibujar. El trazado en progreso usa un estilo propio de alto
  contraste (`DRAW_STYLES` en `DashboardSection.tsx`, un solo color
  morado consistente para "todavía no guardado", ver
  `PREVIEW_COLOR`/`DRAW_COLOR`) en vez del theme por defecto de
  `mapbox-gl-draw` (10% de opacidad, pensado para un mapa base
  genérico) - se perdía contra satelital.
- **Vista previa en vivo del radio (círculo) y del ancho del corredor
  (ruta)**, en el mismo morado, mientras se escribe en el formulario o
  se mueve un vértice - antes esos valores no se veían reflejados en
  el mapa hasta guardar la geocerca, solo el punto/línea sin
  dimensión. La previsualización del corredor dibuja las dos franjas
  (ancho seguro + margen de advertencia), igual que se ve una vez
  guardada. El polígono no necesita este paso aparte - su propio
  trazo en progreso ya ES la forma final.
- **Edición real de vértices** al editar un polígono o ruta ya
  guardada (o al terminar de dibujar una nueva, antes de presionar
  "Crear") - cambia automáticamente a modo `direct_select` de
  `mapbox-gl-draw`, que permite arrastrar cualquier vértice, agregar
  uno nuevo arrastrando un punto medio, o borrarlo con Supr/Backspace.
  Antes solo se podía cambiar nombre/tipo, no la forma en sí. Al
  entrar a editar, el mapa además encuadra automáticamente la
  geometría completa - antes había que encontrarla a mano si no
  estaba ya visible.
- Colores de geocerca **guardada** más saturados (no pastel) para
  advertencia/peligro/estacionamiento, con un borde de 3px 100% opaco
  sobre un relleno translúcido al 30% - se ven distintivos contra
  calles y satelital sin dejar de mostrar el terreno debajo
  (`colorForGeofence` en `packages/map-core/src/geofenceLayer.ts`,
  compartido por Admin/Supervisor/Operador - el cambio de color aplica
  en los tres paneles).
- **Deliberadamente no se agregaron formas geométricas nuevas**
  (rectángulo, dibujo libre, etc.) en esta ronda - círculo/polígono/
  ruta ya cubren los casos reales de uso (zona puntual, área
  autorizada, corredor de tránsito) y agregar una forma nueva
  significa migración de schema + validación + render en los 3
  paneles, no solo el formulario de Admin. Se priorizó en cambio que
  las 3 formas existentes sean completamente editables y precisas.
- Mapa con calles reales (OSM) o modo offline (MBTiles), intercambiable
  con un botón - útil si el sitio no tiene conectividad.
- Exportar en **GeoJSON** (estándar principal, nativo en
  JS/QGIS/Leaflet/Mapbox) o **KML** (Google Earth, muy usado en
  topografía/minería) - botones dentro del overlay "Geocercas" (lista/
  administra las ya creadas). Importar abre un modal chico que pide el
  archivo y, si el alcance elegido es "Global", también el proyecto
  destino (un GeoJSON/KML nunca trae esa información) - antes de esto
  faltaba pedirlo, así que en "Global" el botón de importar fallaba
  siempre con "Selecciona un proyecto primero".

## Visor de recorridos por día

**"Historial" es un modo dentro del Dashboard de Admin** (no una
sección aparte) - un botón propio en el menú, visible solo con un
proyecto específico elegido (nunca en "Global", igual que "Turnos").
Al activarlo, el mismo mapa grande de Dashboard deja de mostrar
vehículos en vivo/equipo estático y dibuja en cambio el recorrido
histórico del dispositivo elegido - las geocercas y los mapas
satelitales ya cargados se quedan visibles como referencia, es el
mismo mapa, no uno nuevo. El recorrido se dibuja como una línea sobre
el mapa, coloreada por tramo según si el vehículo estaba dentro de
una zona/ruta autorizada (azul) o fuera de todas (rojo) - usa
`GET /api/reports/history-with-zones`, que cruza cada posición contra
las geocercas activas **del mismo proyecto** con la misma lógica de
`GeofenceAlertService` (antes cruzaba contra las geocercas de
*todos* los proyectos - ver aislamiento por proyecto más abajo).

Un panel de filtro (dispositivo del proyecto activo + rango de
fechas + Buscar) aparece arriba a la derecha; una barra de
reproducción (▶/⏸ + control deslizante) flota abajo, centrada, para
avanzar manualmente punto por punto; y un panel deslizable a la
derecha (se abre/cierra con una animación, sin bloquear el mapa
mientras está oculto) muestra el detalle de cada punto - fecha,
lat/lon, velocidad, **rumbo, altitud, precisión y batería** (estos
últimos cuatro ya venían en la respuesta del backend, solo no se
mostraban), más la zona - cada fila es clickeable y salta la
reproducción a ese punto.

**Aislamiento por proyecto** - las 3 rutas de `reports.routes.ts`
(`/history`, `/history-with-zones`, `/history/csv`) ahora comprueban
que el `deviceId` consultado pertenezca al proyecto del usuario (o al
`projectId` explícito que mande Admin) antes de responder - `403` si
no coincide, `404` si el dispositivo no existe. Antes no había ningún
chequeo: cualquier cuenta con acceso al panel podía consultar el
historial de un dispositivo de otro proyecto.

## Importador de mapas satelitales (TIF/TFW → MBTiles)

**Panel Admin → Dashboard → overlay Mapas** (con el alcance elegido
arriba - ver [Multi-tenencia por proyecto](#multi-tenencia-por-proyecto);
disponible también para `project_manager`, acceso completo pero
acotado a los mapas de su propio proyecto - `PATCH`/activar/
desactivar/eliminar por id verifican esa pertenencia del lado del
servidor, no solo lo que filtra la lista)
permite importar imágenes satelitales o de dron georreferenciadas
(par `.tif`+`.tfw` o `.jpg`+`.jpw`) y convertirlas al formato offline
(`.mbtiles`) que ven Operador y Supervisor en tiempo real. Cada mapa
pertenece a un proyecto (`maps.project_id`) - Operador/Supervisor solo
ven los mapas de su propio proyecto; Admin, con "Global" elegido, ve
todos sin filtrar y el mapa grande del Dashboard los superpone todos a
la vez.

- **Subida** - nombre + imagen + world file + sistema de coordenadas
  (CRS) de origen. Un world file **nunca** incluye el CRS, solo
  tamaño de píxel y origen en las unidades que sea - el sistema
  intenta detectarlo automáticamente leyendo la imagen
  (`gdalsrsinfo`); si no lo encuentra, usa el que elijas en el
  formulario (UTM zona 13N preseleccionado, coincide con los
  levantamientos reales del sitio - ajústalo si tu insumo viene de
  otra zona/proyección). **Nunca se asume el CRS en silencio** - un
  CRS incorrecto ubica el mapa en el lugar o a la escala equivocada
  sin ningún error visible.
- **Procesamiento** - corre en segundo plano con GDAL
  (`gdal_translate` + `gdal2tiles.py`, instalado en la imagen Docker
  del backend) de forma asíncrona (`child_process.execFile`, no
  bloqueante) - nunca congela la recepción de telemetría GPS en
  tiempo real mientras procesa una ortofoto grande. Puede tardar
  varios minutos; el panel hace polling cada 3s mientras el estado
  sea `processing`.
- **Varios mapas activos a la vez** - a diferencia de la primera
  versión, no hay límite de uno solo: puedes subir, por ejemplo, 3
  levantamientos de la misma zona en días distintos y activarlos
  todos - se apilan como capas independientes, **la más nueva
  (`created_at`) siempre arriba**. Cada mapa se sirve por su propio
  id (`/tiles/maps/:id/{z}/{x}/{y}.png}`), no hay un único archivo
  fijo como antes.
- **Tiempo real** - activar/desactivar un mapa en Admin se refleja
  al instante en Operador y Supervisor sin recargar la página
  (evento de Socket.io `maps:active_update`, con hidratación
  automática al conectar - ver `FleetSocketServer.ts`).
- **Nunca desaparece con el zoom** - el rango de zoom real generado
  por GDAL (`min_zoom`/`max_zoom`) se guarda y se declara en la
  _fuente_ de MapLibre, no en la capa - así, más allá del zoom nativo
  de los tiles, MapLibre reutiliza automáticamente el tile de mayor
  resolución disponible (sobre/sub-muestreo) en vez de dejar la capa
  en blanco.
- **Selector de 3 modos** en Operador y Supervisor - Calles (solo
  OSM), Satelital (solo las capas importadas) y Mixto (ambas
  superpuestas, calles a baja opacidad como referencia). La
  preferencia se guarda en `localStorage` de cada panel.
- **Eliminar** - borra el registro, su `.mbtiles` y los archivos
  fuente subidos. No se puede eliminar un mapa mientras esté activo
  (desactívalo primero).
- Los archivos fuente originales se conservan en
  `/app/maps/sources/<id>/` dentro del contenedor (volumen `maps_data`,
  no en el host ni en git) por si hace falta reprocesar; si el
  resultado quedó mal georreferenciado, la manera de corregirlo es
  volver a importar con el CRS correcto, no editar el mapa ya
  generado.
- Solo un mapa a la vez puede estar en `processing` de forma
  práctica - no hay cola de trabajos; para una operación de este
  tamaño no hizo falta construir una.

## Instalación y despliegue

Un único flujo, con **un solo comando**, para desarrollo local o
para producción en un servidor - no hay archivos ni pasos
distintos entre entornos. Todo el sistema (backend + la SPA +
PostgreSQL + Redis) corre en contenedores Docker orquestados por
[docker-compose.yml](docker-compose.yml).

**Requisitos**: Docker Desktop (o Docker Engine + Compose plugin en Linux).

```bash
# 1. Clonar el repositorio
git clone https://github.com/SrRusian/gaga-gps-001.git
cd gaga-gps-001

# 2. Configurar variables de entorno (único archivo, ver sección
#    "Variables de entorno" abajo)
cp .env.example .env
# Editar .env - como mínimo cambia DB_PASSWORD, REDIS_PASSWORD,
# JWT_SECRET y TELEMETRY_SHARED_SECRET

# 3. Levantar TODO el stack (build de la imagen del backend +
#    Postgres + Redis; las migraciones de db/migrations/ se aplican
#    automáticamente la primera vez que se crea el volumen)
docker compose up -d --build
```

**No hace falta un paso 4** - si la tabla de usuarios está
completamente vacía (primera vez que se crea el volumen de
PostgreSQL), el backend crea automáticamente un usuario admin al
arrancar: **`admin@gaga.com` / `admin`** (o los valores que hayas
puesto en `DEFAULT_ADMIN_EMAIL`/`DEFAULT_ADMIN_PASSWORD` en tu `.env`
- ver [Variables de entorno](#variables-de-entorno)). Queda anotado
bien visible en `docker compose logs gaga-backend`.

> **Cambia esa contraseña de inmediato** - entra a la raíz del
> sitio (`/`, el login único) con esas credenciales y actualízala
> desde **Usuarios** una vez dentro de `/admin` (o define
> `DEFAULT_ADMIN_PASSWORD` en tu `.env` _antes_ del primer arranque
> si prefieres no usar nunca la de por defecto). Este mecanismo solo
> se activa una vez, con la tabla vacía - no vuelve a crear el
> usuario si ya existe alguno, ni siquiera si borras justo ese.

Puedes crear más usuarios (operadores, supervisores, otros admins)
desde el propio panel una vez logueado. El script manual sigue
disponible si prefieres crear el primer admin tú mismo con tus
propias credenciales en vez de usar el automático, o para resetear
una contraseña sin pasar por el panel:

```bash
docker compose exec gaga-backend \
  npm run seed:admin -- admin@tuempresa.com TuPasswordSegura "Nombre Admin"
```

Para actualizar tras un cambio de código:

```bash
git pull
docker compose up -d --build
```

### Caddy: HTTPS y dominio

El servicio `caddy` (`caddy:2.11`, contenedor `gaga-caddy`) publica los
puertos públicos `80` y `443` y actúa como reverse proxy HTTPS. Para
producción, crea registros DNS **A** (IPv4) y/o **AAAA** (IPv6) para
ambos nombres, apuntando a la IP pública del servidor:

- `gaga-maquinaria.com`
- `app.gaga-maquinaria.com`

El firewall, proveedor cloud y router del servidor deben permitir tráfico
entrante público en `80/tcp` y `443/tcp`. Con ambos nombres resolviendo al
host, Caddy obtiene y renueva automáticamente los certificados TLS. La URL
principal del sistema es `https://app.gaga-maquinaria.com`; las peticiones a
`https://gaga-maquinaria.com` se redirigen a
`https://app.gaga-maquinaria.com` conservando la ruta y los parámetros.

El `Caddyfile` dirige `app.gaga-maquinaria.com` a
`gaga-backend:3001` dentro de la red Docker. `reverse_proxy` de Caddy
soporta las conexiones WebSocket usadas por Socket.io, por lo que las UIs y
los eventos en tiempo real funcionan a través del mismo dominio HTTPS.

Comandos útiles para comprobar, recargar y revisar Caddy:

```bash
# Validar la configuración que ve el contenedor
docker compose exec caddy caddy validate \
  --config /etc/caddy/Caddyfile --adapter caddyfile

# Recargarla sin detener el proxy
docker compose exec caddy caddy reload \
  --config /etc/caddy/Caddyfile --adapter caddyfile

# Ver solicitudes, certificados y errores
docker compose logs -f caddy
```

### Aislamiento de contenedores - qué toca el host y qué no

Todo el stack corre containerizado; ningún proceso de la aplicación
corre directo en el host. Inventario completo de cada `volumes:` de
`docker-compose.yml`, para que quede explícito qué es dato real y qué
es solo configuración de solo lectura:

| Mount                                            | Tipo                         | Qué es                                                                                          |
| ------------------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `postgres_data:/home/postgres/pgdata`            | Volumen con nombre           | Datos de PostgreSQL - gestionado 100% por Docker, nunca visible como carpeta del host           |
| `redis_data:/data`                               | Volumen con nombre           | Estado en vivo de la flota                                                                      |
| `maps_data:/app/maps`                            | Volumen con nombre           | `.mbtiles` + fuentes de mapas satelitales importados desde Admin                                |
| `caddy_data:/data`, `caddy_config:/config`       | Volumen con nombre           | Certificados TLS y estado interno de Caddy                                                      |
| `./caddy:/etc/caddy:ro`                          | Bind mount, **solo lectura** | El `Caddyfile` del propio repo (versionado en git) - Caddy solo lo lee al arrancar              |
| `./db/migrations:/docker-entrypoint-initdb.d:ro` | Bind mount, **solo lectura** | Los `.sql` del propio repo - Postgres solo los lee una vez, al crear el volumen por primera vez |

Los dos bind mounts que quedan son de **configuración versionada en
git**, no de datos - se leen una sola vez al arrancar y nunca se
escriben, así que no dependen de permisos del usuario del host ni
crean nada fuera del contenedor. Son intencionalmente distintos del
bind mount original de `maps` (el incidente que arrancó esta
limpieza): aquel montaba una carpeta **de datos, escribible**, lo que
sí creaba una carpeta en el host con el dueño equivocado. Esa carpeta
se reemplazó por el volumen con nombre `maps_data` de la tabla de
arriba - ningún directorio de datos del proyecto vive ya en el
filesystem del host.

El backend corre como usuario no-root (`USER node` en
`apps/backend/Dockerfile`, con `chown -R node:node` aplicado dentro
de la imagen antes de cambiar de usuario) - ni siquiera dentro del
propio contenedor corre con privilegios de root.

### Persistencia de datos - instalación limpia vs. actualización vs. borrado total

- **Bug crítico encontrado y corregido (ruta de montaje de
  PostgreSQL)** - `docker-compose.yml` montaba el volumen
  `postgres_data` en `/var/lib/postgresql/data`, la ruta estándar de
  la imagen oficial `postgres`, pero este proyecto usa
  `timescale/timescaledb-ha` (variante orientada a alta
  disponibilidad, con Patroni) - **esa imagen guarda los datos reales
  en `/home/postgres/pgdata`, no en la ruta estándar**. El volumen
  con nombre existía y Compose lo reutilizaba correctamente entre
  builds, pero como la ruta de montaje no coincidía con dónde el
  motor de Postgres realmente escribe, los datos vivían en la capa
  interna (efímera) del contenedor - se veían "persistentes" mientras
  el contenedor de Postgres no se recreara, pero **cualquier
  recreación del contenedor (`docker compose down` + `up`, cambiar
  cualquier valor de `docker-compose.yml`, o incluso clonar el repo
  en una carpeta nueva y volver a desplegar) borraba todo
  silenciosamente y volvía a correr las migraciones desde cero**.
  Se encontró durante una prueba deliberada de "clonar en carpeta
  nueva y redesplegar" (simulando el flujo real de servidor: push →
  clone → `docker compose up -d --build`) - se corrigió el montaje a
  `postgres_data:/home/postgres/pgdata` y se verificó explícitamente
  que los datos sobreviven tanto a un `docker compose down && up`
  completo (contenedores, red y todo destruido y recreado) como a un
  redespliegue desde una carpeta distinta con el mismo
  `docker-compose.yml`. Redis y Caddy se revisaron con el mismo
  criterio y sus rutas de montaje sí eran correctas desde el
  principio (`/data` y `/data`+`/config` respectivamente, verificado
  contra la imagen oficial de cada uno).
- **`docker compose up -d --build`** (el comando de siempre, primera vez
  o actualización) **nunca borra datos** - PostgreSQL, Redis y los
  mapas satelitales (`.mbtiles`) viven en volúmenes con nombre
  (`postgres_data`, `redis_data`, `maps_data`, `caddy_data`,
  `caddy_config`) que Compose reutiliza automáticamente si ya existen.
  Los dos últimos conservan certificados y estado de Caddy. Reconstruir la imagen del backend solo reemplaza el código; los contenedores de base de datos ni se tocan si no cambiaron.
- El nombre de esos volúmenes está fijado explícitamente
  (`name: gaga-gps-001` al inicio de `docker-compose.yml`) - **no**
  depende del nombre de la carpeta donde clonaste el repo. Antes de
  este fix sí dependía, y era la causa típica de "cloné el repo de
  nuevo y perdí todos mis datos": si el repo se clona a una carpeta
  con otro nombre, Docker Compose generaba volúmenes nuevos y vacíos
  en vez de reusar los existentes - los datos viejos no se borraban,
  quedaban huérfanos bajo el volumen anterior, invisibles a menos que
  supieras buscarlos con `docker volume ls`.
- `db/migrations/001_init.sql` **solo se aplica una vez**, la primera
  vez que se crea el volumen de PostgreSQL (comportamiento estándar
  de la imagen oficial) - es un solo archivo con el schema completo,
  sin pasos incrementales, porque hoy no existe ningún despliegue con
  datos reales que migrar (ver el comentario al inicio del archivo).
  El día que sí exista, un cambio de schema se agrega como un
  **segundo** archivo nuevo (`002_lo_que_sea.sql`) - nunca editando
  `001_init.sql`, que ya no se re-ejecuta en un volumen con datos - y
  se aplica a mano una sola vez:
  `docker exec -i gaga-postgres psql -U gaga_app -d gaga_gps < db/migrations/002_lo_que_sea.sql`.
- **Borrado total intencional** (para empezar de cero de verdad -
  ej. quieres una base de datos limpia para pruebas): comando
  explícito, no accidental:
  ```bash
  docker compose down -v
  ```
  El `-v` es lo que borra los volúmenes - sin él, `docker compose down`
  (o simplemente apagar y prender Docker Desktop) conserva todo. **Ojo:**
  esto también borra `maps_data`, es decir, los `.mbtiles` importados -
  no es un comando para usar a la ligera en producción.

Notas:

- `NODE_ENV=production` (default en `.env.example`) activa
  validaciones estrictas - el backend **no arranca** si faltan
  `JWT_SECRET` o `TELEMETRY_SHARED_SECRET`. Usa `NODE_ENV=development`
  en `.env` si estás iterando localmente y quieres omitir esa
  validación.
- `gaga-backend` depende de que `postgres` y `redis` pasen su
  healthcheck antes de arrancar, y expone su propio healthcheck en
  `/health` (visible en `docker compose ps`).
- Los `.mbtiles` viven en el volumen nombrado `maps_data`, gestionado
  por Docker (no en una carpeta del host) - se importan siempre desde
  el panel Admin → Dashboard → overlay Mapas, nunca copiando
  archivos a mano.

### Alternativa: correr el backend sin Docker (avanzado)

Para iteración rápida con hot-reload durante desarrollo activo del
código, puedes correr el backend directo con `node`, apuntando a un
Postgres/Redis que sigues levantando con Docker. El `npm install` se
hace **una sola vez en la raíz** (es un monorepo con `npm workspaces`
- instalar dentro de `apps/backend` directamente no resuelve los
`packages/*` de los que depende). No hace falta ningún `.env` aparte
- el backend siempre lee el único `.env` de la raíz, sin importar
desde qué carpeta se arranque el proceso (`apps/backend/src/config/loadEnv.ts`
resuelve la ruta usando su propia ubicación en el repo, no el
directorio de trabajo del proceso):

```bash
docker compose up -d postgres redis     # solo las dependencias
npm install                             # una vez, desde la raíz del repo
npm run dev:backend                     # tsx watch - recompila y reinicia solo con guardar
```

`npm run dev:backend` corre `apps/backend/src/app.ts` directo con
`tsx` (sin paso de build) - con la base de datos vacía, crea el admin
por defecto igual que en Docker (ver arriba). Para la SPA en modo
desarrollo (hot module reload de Vite, proxy a `localhost:3001` ya
configurado en `vite.config.ts`):

```bash
npm run dev --workspace=@gaga-gps/web-app   # http://localhost:5173
```

Al ser una sola app con React Router, el login y las 3 vistas por rol
viven en el mismo puerto - inicia sesión y la propia app te redirige
a `/admin`, `/supervisor` u `/operator` según el rol, igual que en
producción, sin pasos extra.

El script manual (`docker compose exec gaga-backend npm run seed:admin -- ...`)
sigue disponible si prefieres definir tú las credenciales del primer
usuario desde el arranque. Fuera de Docker corre sobre el `dist/`
compilado (`npm run build --workspace=@gaga-gps/backend` primero,
luego `npm run seed:admin --workspace=@gaga-gps/backend -- ...`).

Este flujo es opcional y no forma parte del despliegue estándar.

### URLs del sistema

| Ruta                                 | Descripción                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `http://localhost:3001/`             | Login único (gateway) - redirige a /admin, /supervisor u /operator según el rol         |
| `GET/POST http://localhost:3001/gps` | Receptor de telemetría (usado por las tabletas)                                         |
| `http://localhost:3001/operator`     | UI Operador                                                                             |
| `http://localhost:3001/supervisor`   | UI Supervisor                                                                           |
| `http://localhost:3001/admin`        | Panel de administración (rol `admin`)                                                   |
| `http://localhost:3001/encargado`    | Mismo panel de administración, rol `project_manager` (acotado a su proyecto)            |
| `http://localhost:3001/health`       | Health check (estado de Postgres/Redis)                                                 |
| `https://app.gaga-maquinaria.com`    | URL pública principal en producción, servida por Caddy - abre directo en el login único |

En producción usa la URL HTTPS de Caddy; las direcciones `localhost:3001`
son útiles para desarrollo o acceso directo al backend.

## Variables de entorno

Todas definidas en un único archivo - [.env.example](.env.example)
(raíz) - copiar a `.env` y completar. Es el mismo archivo para
desarrollo con Docker, para correr el backend sin Docker (flujo
avanzado - ver [Alternativa: correr el backend sin Docker](#alternativa-correr-el-backend-sin-docker-avanzado))
y para producción; lo único que cambia según el entorno es el valor
de `NODE_ENV`. No existe un segundo `.env` dentro de `apps/backend`
- el backend siempre resuelve el de la raíz sin importar desde dónde
se arranque el proceso (ver `apps/backend/src/config/loadEnv.ts`).

`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `REDIS_HOST` y
`REDIS_PORT` **no** están en `.env`: son fijos dentro de la red
Docker (`docker-compose.yml` los define directamente como
`postgres`/`redis`, los nombres de los servicios) y no hace falta
tocarlos.

| Variable                                  | Obligatoria                   | Descripción                                                                                                                                                                                        |
| ----------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB_PASSWORD`                             | Sí                            | Contraseña de PostgreSQL                                                                                                                                                                           |
| `REDIS_PASSWORD`                          | Sí                            | Contraseña de Redis                                                                                                                                                                                |
| `NODE_ENV`                                | Sí                            | `development` o `production` - activa validaciones estrictas de seguridad en `production`                                                                                                          |
| `JWT_SECRET`                              | **Obligatoria en producción** | Firma de tokens del panel admin. El backend **falla al arrancar** si `NODE_ENV=production` y falta                                                                                                 |
| `TELEMETRY_SHARED_SECRET`                 | **Obligatoria en producción** | Clave compartida para `/gps` - mitiga que terceros inyecten posiciones falsas. El backend falla al arrancar en producción si falta. Ver detalle en [Seguridad del backend](#seguridad-del-backend) |
| `JWT_EXPIRES_IN`                          | No (default `8h`)             | Vigencia del token de sesión del panel admin                                                                                                                                                       |
| `OPERATOR_JWT_EXPIRES_IN`                 | No (default `30d`)            | Vigencia del token de la UI de operador - ver [Turnos de operador](#turnos-de-operador-y-vinculación-de-dispositivo)                                                                               |
| `OPERATOR_SESSION_MAX_IDLE_DAYS`          | No (default `7`)              | Días sin heartbeat tras los cuales se cierra automáticamente un turno abandonado                                                                                                                   |
| `MAPS_DIR`                                | No (default `maps`)           | Carpeta con los archivos `.mbtiles` servidos en `/tiles`                                                                                                                                           |
| `POSITION_FILTER_TOLERANCE_FACTOR`        | No (default `1.8`)            | Margen sobre la velocidad reciente del dispositivo antes de considerar un salto sospechoso - ver [Filtro de posiciones GPS](#filtro-de-posiciones-gps-anti-teletransporte-rtkntrip)                |
| `POSITION_FILTER_MIN_FLOOR_KMH`           | No (default `25`)             | Piso mínimo (km/h) del umbral adaptativo - headroom para arrancar desde parado                                                                                                                     |
| `POSITION_FILTER_ABSOLUTE_CEILING_KMH`    | No (default `120`)            | Techo de seguridad (km/h) del umbral adaptativo                                                                                                                                                    |
| `POSITION_FILTER_JITTER_RADIUS_M`         | No (default `5`)              | Radio (metros) de ruido GPS normal con el vehículo detenido                                                                                                                                        |
| `POSITION_FILTER_HISTORY_WINDOW`          | No (default `8`)              | Cuántas velocidades recientes se recuerdan por dispositivo                                                                                                                                         |
| `POSITION_FILTER_MAX_CONSECUTIVE_REJECTS` | No (default `3`)              | Rechazos consecutivos antes de resincronizar (fail-open)                                                                                                                                           |
| `MAX_MAP_UPLOAD_MB`                       | No (default `500`)            | Tamaño máximo por archivo al importar un mapa satelital/drone                                                                                                                                      |
| `DEFAULT_ADMIN_EMAIL`                     | No (default `admin@gaga.com`) | Email del admin creado automáticamente si la tabla de usuarios está vacía al arrancar                                                                                                              |
| `DEFAULT_ADMIN_PASSWORD`                  | No (default `admin`)          | Contraseña de ese admin - **cámbiala** desde el panel tras el primer login, o define esta variable antes del primer arranque                                                                       |

## Configurar Traccar Client en las tabletas

En la app **Traccar Client** (Android/iOS), configurar:

- **Device Identifier**: cualquier texto único para ese vehículo/
  equipo (ej. `CAMION-01`). Se convierte en `unique_id` en la tabla
  `devices` - recomendamos usar el mismo valor al registrar el
  dispositivo en el panel Admin, para que quede con un nombre
  amigable desde el primer reporte.
- **Server URL**: URL completa hasta `/gps` - **no** uses `localhost`
  (la tableta es un dispositivo distinto; usa la IP LAN o el
  dominio real del backend):
  ```
  http://<ip-o-dominio-del-backend>:3001/gps
  ```
  Si configuraste `TELEMETRY_SHARED_SECRET`, agrega el query param:
  ```
  http://<ip-o-dominio-del-backend>:3001/gps?key=TU_CLAVE_SECRETA
  ```
  Traccar Client añade sus propios parámetros después, sin
  sobreescribir el que ya pusiste.
- **Frequency / Distance**: recomendado alta precisión con
  intervalo de 15-20 segundos como referencia general - el sistema
  también soporta reportes mucho más frecuentes (hasta 1/segundo)
  gracias a la política de compresión de datos (ver más abajo).

El backend acepta indistintamente `GET` o `POST`, y los parámetros
ya sea en la URL (query string) o en el cuerpo de la petición
(`application/x-www-form-urlencoded`) - distintas versiones de
Traccar Client usan una u otra forma.

## Referencia de la API

Todas las rutas bajo `/api/*` (excepto `/api/auth/login` y
`/api/fleet/*`) requieren header `Authorization: Bearer <token>`
obtenido en el login.

| Método   | Ruta                                      | Auth                       | Descripción                                                                                                                                                                       |
| -------- | ----------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET/POST | `/gps`                                    | Clave compartida opcional  | Receptor de telemetría (protocolo OsmAnd)                                                                                                                                         |
| GET      | `/tiles/maps/:mapId/:z/:x/:y.png`         | No                         | Tiles offline (MBTiles) de un mapa específico                                                                                                                                     |
| GET      | `/tiles/active-maps.json`                 | JWT opcional               | Lista de mapas activos+listos, del más viejo al más nuevo - la usan Operador/Supervisor al cargar. Sin token: todos los mapas activos, sin filtrar (compatibilidad con llamadores públicos). Con token de un rol de proyecto: solo los del proyecto del usuario; con token `admin`: todos, igual que sin token |
| GET      | `/api/maps`                               | JWT (`admin`)              | Listar mapas importados con su estado                                                                                                                                             |
| POST     | `/api/maps`                               | JWT (`admin`)              | Importar mapa - multipart `name`, `image`, `worldFile`, `sourceCrs`                                                                                                               |
| PATCH    | `/api/maps/:id`                           | JWT (`admin`)              | Renombrar un mapa                                                                                                                                                                 |
| POST     | `/api/maps/:id/activate`                  | JWT (`admin`)              | Activa este mapa como capa visible (varios pueden estar activos a la vez)                                                                                                         |
| POST     | `/api/maps/:id/deactivate`                | JWT (`admin`)              | Desactiva este mapa                                                                                                                                                               |
| DELETE   | `/api/maps/:id`                           | JWT (`admin`)              | Eliminar un mapa (rechaza si está activo)                                                                                                                                         |
| POST     | `/api/auth/login`                         | No                         | Login único (`features/auth/LoginScreen.tsx`) - devuelve JWT + rol. La duración del token la decide el backend según el rol (ver [Autenticación y roles](#autenticación-y-roles)) |
| POST     | `/api/auth/logout`                        | No                         | Logout (invalidación es responsabilidad del cliente)                                                                                                                              |
| GET      | `/api/devices/lookup/:uniqueId`           | No                         | Verifica si un dispositivo existe y si tiene turno activo - usado por la pantalla de configuración del panel Operador                                                             |
| GET      | `/api/devices`                            | JWT                        | Listar dispositivos                                                                                                                                                               |
| GET      | `/api/devices/:id`                        | JWT                        | Detalle de un dispositivo                                                                                                                                                         |
| POST     | `/api/devices`                            | JWT                        | Crear dispositivo                                                                                                                                                                 |
| PATCH    | `/api/devices/:id`                        | JWT                        | Editar dispositivo                                                                                                                                                                |
| DELETE   | `/api/devices/:id?force=true`             | JWT                        | Eliminar dispositivo (`force=true` purga también su historial de posiciones; sin ese flag, responde 409 si tiene historial)                                                       |
| GET      | `/api/geofences`                          | JWT                        | Listar geocercas activas (cualquier forma)                                                                                                                                        |
| POST     | `/api/geofences`                          | JWT                        | Crear geocerca - `shapeType`: `circle` \| `polygon` \| `polyline`; `type`: `warning` \| `danger` \| `parking`                                                                     |
| PATCH    | `/api/geofences/:id`                      | JWT                        | Editar geocerca (nombre, tipo, forma/coordenadas, activo)                                                                                                                         |
| DELETE   | `/api/geofences/:id`                      | JWT                        | Eliminar geocerca                                                                                                                                                                 |
| GET      | `/api/geofences/export.geojson`           | JWT (header o `?token=`)   | Exportar todas las geocercas activas en GeoJSON - único par de rutas que también acepta el JWT por query string (`buildDownloadAuthMiddleware`), porque el panel las descarga con un `<a href>` real, que no puede mandar el header `Authorization` |
| GET      | `/api/geofences/export.kml`               | JWT (header o `?token=`)   | Exportar todas las geocercas activas en KML - mismo criterio que `export.geojson`                                                                                                 |
| POST     | `/api/geofences/import`                   | JWT                        | Importar geocercas - body `{ format: 'geojson'\|'kml', data }`                                                                                                                    |
| GET      | `/api/equipment`                          | JWT                        | Listar equipo estático                                                                                                                                                            |
| POST     | `/api/equipment`                          | JWT                        | Crear equipo estático                                                                                                                                                             |
| PATCH    | `/api/equipment/:id`                      | JWT                        | Editar nombre/tipo/posición/radios/dispositivo vinculado (`linkedDeviceId`, `409` si esa tableta ya está vinculada a otro equipo)                                                 |
| PATCH    | `/api/equipment/:id/status`               | JWT                        | Cambiar estado manualmente (`active_swing` / `active_pause` / `inactive`) - ignorado en la práctica si el equipo tiene tableta vinculada, ver `operator-sessions/start`/`end`     |
| DELETE   | `/api/equipment/:id`                      | JWT                        | Eliminar equipo                                                                                                                                                                   |
| GET      | `/api/reports/history`                    | JWT                        | Historial de posiciones (JSON) por dispositivo y rango de fechas - `403` si el dispositivo no pertenece al proyecto del usuario (o al `?projectId=` explícito de Admin)           |
| GET      | `/api/reports/history-with-zones`         | JWT                        | Igual que `/history`, anotando en qué geocerca (del mismo proyecto) estaba cada posición (usado por el modo Historial de Dashboard)                                               |
| GET      | `/api/reports/history/csv`                | JWT                        | Exportar historial a CSV (velocidad ya en km/h) - mismo chequeo de proyecto que las anteriores                                                                                    |
| GET      | `/api/users`                              | JWT (`admin`)              | Listar usuarios                                                                                                                                                                   |
| POST     | `/api/users`                              | JWT (`admin`)              | Crear usuario                                                                                                                                                                     |
| PATCH    | `/api/users/:id`                          | JWT (`admin`)              | Editar usuario (nombre, rol, activo)                                                                                                                                              |
| POST     | `/api/users/:id/password`                 | JWT (`admin`)              | Cambiar contraseña                                                                                                                                                                |
| DELETE   | `/api/users/:id`                          | JWT (`admin`)              | Eliminar usuario                                                                                                                                                                  |
| GET      | `/api/operator-sessions/active?deviceId=` | No                         | Turno activo (si lo hay) de un dispositivo                                                                                                                                        |
| POST     | `/api/operator-sessions/start`            | JWT                        | Inicia turno del usuario autenticado en un dispositivo (cierra automáticamente cualquier turno previo abierto de ese dispositivo). Si el dispositivo tiene equipo estático vinculado, lo pasa a `active_pause` y lo incluye en la respuesta (`equipment: {...} | null`) |
| POST     | `/api/operator-sessions/:id/end`          | JWT                        | Cierra el turno explícitamente - si el dispositivo tenía equipo estático vinculado, lo regresa a `inactive`                                                                       |
| POST     | `/api/operator-sessions/:id/heartbeat`    | JWT                        | Marca actividad reciente - evita el cierre automático por inactividad                                                                                                             |
| GET      | `/api/operator-sessions/report`           | JWT (`admin`/`supervisor`) | Reporte de turnos por operador y/o dispositivo, con duración                                                                                                                      |
| GET      | `/api/fleet/state`                        | No                         | Estado actual de toda la flota (lectura desde Redis)                                                                                                                              |
| POST     | `/api/fleet/stop`                         | JWT (`supervisor`/`admin`) | Activar parada preventiva colectiva                                                                                                                                               |
| POST     | `/api/fleet/resume`                       | JWT (`supervisor`/`admin`) | Desactivar parada preventiva                                                                                                                                                      |
| GET      | `/api/fleet/stop/status`                  | No                         | Estado actual de la parada preventiva                                                                                                                                             |
| GET      | `/health`                                 | No                         | Estado de PostgreSQL/Redis y de la parada preventiva                                                                                                                              |

> Las lecturas de `/api/fleet/*` (`state`, `stop/status`) siguen sin
> requerir JWT - son de solo lectura y de bajo riesgo. Activar/
> desactivar la parada preventiva sí requiere login desde que todos
> los roles tienen cuenta (ver [Autenticación y roles](#autenticación-y-roles));
> antes de eso ambas rutas estaban completamente abiertas.

## Eventos de Socket.io en tiempo real

El servidor emite (y las UIs escuchan) estos eventos:

| Evento                                                                                                                                         | Origen                                | Descripción                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `fleet:update`                                                                                                                                 | PositionProcessor / FleetSocketServer | Nueva posición de uno o más vehículos                                                                  |
| `geofences:update`                                                                                                                             | geofences.routes / FleetSocketServer  | Lista de geocercas activas actualizada                                                                 |
| `equipment:update`                                                                                                                             | equipment.routes                      | Lista de equipo estático actualizada                                                                   |
| `alert:critical` / `alert:warning` / `alert:info` / `alert:clear`                                                                              | GeofenceAlertService                  | Alertas de geocerca al dispositivo afectado (`info` = zona de estacionamiento, sin sirena)              |
| `supervisor:alert`                                                                                                                             | GeofenceAlertService                  | Notificación de geocerca al panel de supervisor                                                        |
| `signal:lost:level1` / `signal:lost:level2` / `signal:recovered`                                                                               | SignalLostService                     | Pérdida/recuperación de señal de un vehículo                                                           |
| `supervisor:signal_lost`                                                                                                                       | SignalLostService                     | Notificación de pérdida de señal al supervisor                                                         |
| `collision:proximity` / `collision:critical` / `collision:clear`                                                                               | CollisionRiskService                  | Riesgo de colisión entre vehículos                                                                     |
| `supervisor:collision`                                                                                                                         | CollisionRiskService                  | Notificación de riesgo de colisión al supervisor                                                       |
| `proximity:distance_update` / `proximity:warning` / `proximity:critical` / `proximity:clear`                                                  | VehicleProximityService               | Distancia en vivo y alertas de proximidad fuera de ruta                                                |
| `supervisor:proximity`                                                                                                                         | VehicleProximityService               | Notificación de proximidad al supervisor                                                               |
| `fleet:preventive_stop` / `fleet:preventive_stop_clear`                                                                                        | PreventiveStopService                 | Activación/cancelación de parada preventiva colectiva                                                  |
| `supervisor:preventive_stop`                                                                                                                   | PreventiveStopService                 | Notificación al supervisor                                                                             |
| `equipment:approach_outer` / `equipment:approach_inner` / `equipment:minimum_limit` / `equipment:distance_update` / `equipment:approach_clear` | StaticEquipmentManager                | Guía de aproximación a equipo estático                                                                 |
| `equipment:status_update`                                                                                                                      | StaticEquipmentManager                | Cambio de estado de un equipo (`active_swing`/`active_pause`/`inactive`)                               |
| `equipment:vehicle_approaching`                                                                                                                | StaticEquipmentManager                | Notificación al operador del equipo estático                                                           |
| `maps:active_update`                                                                                                                           | maps-admin.routes / FleetSocketServer | Conjunto de mapas satelitales activos cambió - Operador/Supervisor reconstruyen sus capas sin recargar |

## Módulos de seguridad (RF-ALR)

Estos 5 módulos existían antes de la migración y **no se modificaron**
- solo cambió dónde se invocan (antes desde `TraccarWsClient.js`,
ahora desde `PositionProcessor.ts`):

| Módulo                    | RF           | Función                                                                      |
| ------------------------- | ------------ | ---------------------------------------------------------------------------- |
| `GeofenceAlertService`    | RF-ALR-02/03 | Alerta al entrar en zona amarilla (advertencia), roja (peligro) o azul (estacionamiento, sin sirena) |
| `SignalLostService`       | RF-ALR-05    | Nivel 1 (10s sin señal) y Nivel 2 (20s, activa parada preventiva automática) |
| `CollisionRiskService`    | RF-ALR-10    | Anticolisión - distancia + trayectoria proyectada entre vehículos            |
| `VehicleProximityService` | -            | Radar de distancia entre vehículos fuera de un corredor/ruta autorizada (ver [más abajo](#radar-de-proximidad-fuera-de-ruta)) |
| `PreventiveStopService`   | RF-ALR-11    | Parada preventiva colectiva - solo el supervisor puede desactivarla          |
| `StaticEquipmentManager`  | RF-ALR-12    | Guía de aproximación a equipo estático con radio de giro                     |

### Filtro de posiciones GPS (anti-teletransporte RTK/NTRIP)

Cuando el receptor RTK pierde momentáneamente la corrección
(satélite o NTRIP, típicamente ~1 segundo), puede reportar un punto
a decenas de metros de la ruta real y luego el siguiente fix vuelve
a la posición correcta - un "teletransporte" visible en el mapa que,
sin filtrar, también podría alimentar geocercas/colisión con datos
falsos.

`PositionFilterService.ts` corre dentro de `PositionProcessor.ts`,
**antes** de tocar Redis, las alertas o el broadcast a las UIs, y
compara cada posición nueva contra la última posición **aceptada**
de ese mismo dispositivo (distancia Haversine / tiempo transcurrido
= velocidad implícita). No depende de ningún dato de calidad de fix
(RTK Fixed/Float, HDOP) porque el protocolo OsmAnd que usan las
tabletas no lo expone.

El umbral es **adaptativo por dispositivo**, no un límite fijo de
"tipo de vehículo": se basa en la velocidad reciente del propio
dispositivo (con piso y techo de seguridad configurables). Así,
maquinaria pesada lenta rechaza cualquier salto de decenas de
km/h con mucho margen, mientras que un vehículo ligero que ya
circula rápido conserva margen para acelerar sin disparar falsos
rechazos.

Los puntos rechazados **se guardan igual** en `positions`, marcados
`valid = false` con el motivo y los datos numéricos en `attributes`
(`rejectReason`, `impliedSpeedKmh`, `allowedMaxKmh`,
`distanceMeters`) - quedan disponibles para auditar y afinar el
umbral, pero **nunca** aparecen en el mapa en vivo, el historial ni
los reportes/CSV (`PositionRepository` filtra `valid = TRUE` en
todas sus consultas de lectura).

Si un dispositivo encadena varios rechazos seguidos
(`POSITION_FILTER_MAX_CONSECUTIVE_REJECTS`, default 3), el filtro
se resincroniza automáticamente en vez de dejarlo "congelado" fuera
del mapa - asume que de verdad se movió o volvió a tener señal más
lejos.

Auditar rechazos directamente en PostgreSQL:

```sql
SELECT device_id, fix_time, attributes
FROM positions
WHERE valid = false
ORDER BY fix_time DESC
LIMIT 50;
```

Todas las variables de ajuste (`POSITION_FILTER_*`) son opcionales
y tienen default - ver [Variables de entorno](#variables-de-entorno).

### Estimación de velocidad

El `speed` que reporta el GPS (Doppler, instantáneo) puede divergir
bastante de la velocidad real - visto en pruebas: GPS marcando 40
km/h con el vehículo realmente a ~24 km/h. `SpeedEstimationService.ts`
corre en `PositionProcessor.ts` después del filtro anti-teletransporte:
combina ese valor con la velocidad derivada del desplazamiento real
(Haversine/Δt entre fixes), descarta el reportado si diverge más de
`maxDivergenceKmh` (15 km/h por default) y aplica un EMA para suavizar
ruido punto a punto. El valor final sobrescribe `position.speed` (se
usa en mapa, HUD, reportes); el crudo del GPS queda en
`attributes.rawSpeedKmh` para auditoría.

Un vehículo parado nunca reporta exactamente 0 km/h por sí solo - la
posición GPS tiembla unos decímetros por fix aunque no haya movimiento
real, y como la distancia Haversine siempre es positiva sin importar
la dirección de ese temblor, ese ruido se traduce en un piso
artificial de 0.4-0.7 km/h que ni el EMA logra bajar a cero (visto en
campo con TABLETA-01 físicamente quieta). `minSpeedKmh` (1 km/h por
default) es la zona muerta que corrige esto: por debajo del umbral se
reporta 0 en vez del ruido. Se aplica solo al valor devuelto, nunca al
estado interno del EMA, para no distorsionar la reacción real cuando
el vehículo sí arranca a moverse.

### Radar de proximidad fuera de ruta

`VehicleProximityService.ts` - a diferencia de `CollisionRiskService`
(que exige trayectorias convergentes), este es un radar de distancia
puro, pensado para patios/zonas de maniobra sin ruta definida. Solo
evalúa vehículos que **no** estén dentro de un corredor autorizado
(geocerca `polyline`). Umbrales: `VISIBILITY_METERS` (150, solo
actualiza la distancia en vivo en el HUD del operador),
`WARNING_METERS` (80) y `CRITICAL_METERS` (35). Emite
`proximity:distance_update` / `proximity:warning` / `proximity:critical`
/ `proximity:clear` - ver [Eventos de Socket.io](#eventos-de-socketio-en-tiempo-real).

### Formato de precisión GPS/RTK

`formatAccuracy()` (`packages/ui/src/format.ts`) - bajo 1m se muestra
en centímetros en vez de redondear a "±0 m" (usado hoy en el panel de
Supervisor). Con GPS puro esto casi no se nota (rara vez baja de 1m),
pero con RTK en FIX real (el objetivo son unos pocos centímetros)
redondear a metros enteros escondería exactamente la mejora que se
busca medir al pasar a un NTRIP propio/más cercano.

## Seguridad del backend

- **JWT con revalidación activa**: cada request protegido no solo
  valida la firma/expiración del token, también consulta PostgreSQL
  para confirmar que el usuario sigue `active` y conserva el mismo
  rol - si un admin desactiva a alguien, su sesión se corta de
  inmediato, sin esperar a que expire el token.
- **Clave compartida en `/gps`** (`TELEMETRY_SHARED_SECRET`):
  mitiga que un tercero que alcance el endpoint inyecte posiciones
  falsas o sature el sistema con dispositivos inventados. Obligatoria
  en producción (el backend no arranca sin ella).
- **Rate limiting por dispositivo** (no solo por IP): varias
  tabletas detrás del mismo router/NAT de sitio no comparten cupo
  de peticiones entre sí.
- **Validación de rango de coordenadas**: se rechazan posiciones con
  latitud/longitud fuera de `-90..90`/`-180..180`.
- **CSV sin inyección de fórmulas**: los valores exportados a CSV
  (p. ej. `device_id`, configurable libremente en la tableta) se
  escapan para evitar ataques de inyección de fórmulas en Excel/Sheets.
- **Manejo explícito de borrado con historial**: eliminar un
  dispositivo con posiciones registradas responde `409` con mensaje
  claro por defecto, en vez de un error genérico - requiere
  `?force=true` explícito para purgar también su historial.

## Retención y compresión de datos

Las tabletas pueden reportar posición cada 1 segundo, lo que puede
generar cientos de millones de filas al año con flotas grandes. La
hypertable `positions` (TimescaleDB) tiene configurada una política
automática (ver `db/migrations/001_init.sql`):

- **Compresión** - chunks con datos de más de 7 días se comprimen
  automáticamente en segundo plano (10-20x menos espacio en disco),
  sin afectar las consultas de historial/reportes recientes.
- **Retención** - chunks con datos de más de 1 año se eliminan
  automáticamente para liberar espacio.

Redis **no** requiere política de retención - solo guarda la última
posición conocida de cada dispositivo (se sobrescribe en cada
reporte), así que su tamaño depende del número de vehículos, no del
tiempo ni de la frecuencia de reporte.

Para ajustar los intervalos (p. ej. si cambia la política de
retención de la operación), ejecutar directamente en PostgreSQL:

```sql
SELECT remove_retention_policy('positions');
SELECT add_retention_policy('positions', INTERVAL '2 years');
```

Estimados de referencia (con compresión activa):

| Flota        | Frecuencia | Espacio/año (comprimido) |
| ------------ | ---------- | ------------------------ |
| 1 vehículo   | cada 1s    | ~0.5 GB                  |
| 10 vehículos | cada 1s    | ~4-6 GB                  |
| 50 vehículos | cada 1s    | ~20-30 GB                |

## Multi-tenencia por proyecto

El sistema pasó de un solo inquilino a varios **proyectos** (sitios de
operación) aislados entre sí - un usuario/dispositivo de un proyecto
nunca ve datos de otro. `projects` es la tabla raíz; `users.project_id`,
`devices.project_id`, `geofences.project_id`,
`static_equipment.project_id` y `maps.project_id` enlazan cada fila a
un proyecto. `project_id = NULL` en un usuario `admin` es el único
caso de alcance global - todos los demás roles siempre tienen un
proyecto.

**Roles de proyecto** (reutilizan `AdminApp`/`SupervisorApp` con
menos alcance, no paneles nuevos):
- **`project_manager` (Encargado de Proyecto)** - literalmente un
  Admin, pero acotado a su propio proyecto en todo. Acceso total
  (crear/editar/eliminar) a Geocercas, Equipo estático, Turnos e
  Historial de su proyecto. Sobre Dispositivos/Usuarios, permisos más
  finos - nunca **crea ni elimina** ninguno de los dos (exclusivo de
  `admin`); de un dispositivo solo puede editar nombre/tipo (nunca
  reasignarlo de proyecto); de un usuario solo puede activar/
  desactivarlo y cambiarle el **rol** (nunca email/nombre/proyecto),
  y nunca puede asignar el rol `admin` a nadie (le daría a esa cuenta
  alcance global, saltándose el límite "solo mi proyecto" que define
  este rol - el backend lo rechaza con `403` aunque se intente por
  API directa).
- **`project_supervisor` (Supervisor de Proyecto)** - a diferencia de
  `project_manager`, este rol NO reutiliza `DashboardSection.tsx` -
  sigue en su propio panel especializado (`SupervisorApp.tsx`, el
  mismo de siempre en cuanto a datos/funciones), con el mapa y la
  lista de vehículos acotados a **su turno programado asignado**, no a
  todo el proyecto (a diferencia del Encargado, que ve todos los
  turnos). Desde la última ronda, su shell visual sí es el mismo
  sistema flotante estilo Traccar que Admin (mapa como fondo de toda
  la ventana, header semi-transparente flotando encima, todo lo demás
  en columnas fijas tipo "glass") - ver
  [Panel de administración](#panel-de-administración) para el detalle
  de esa técnica, aplicada aquí con las mismas clases `--sup-*`
  espejo de las `--ad-*`. Nunca crea/edita/elimina ni activa/desactiva
  Dispositivos o Usuarios; sin Historial de recorridos, Reportes ni
  "Sistema" (ninguno existe en este panel). Sí tiene acceso completo
  (crear/editar/eliminar) a Geocercas/Equipo estático/Mapas de su
  proyecto (`GeoManagementPanel.tsx`, menú en la columna flotante
  izquierda) - mismo criterio de "acceso total dentro de su proyecto"
  que Encargado, pero solo para estos tres recursos. El historial de
  **alertas** (no de posiciones) se acota además a su propio turno
  (`ShiftResolverService.mostRecentShiftStartForSupervisor`,
  aplicado en `alerts.routes.ts`) - salvo una alerta todavía **activa**
  de un turno anterior, que sigue visible hasta resolverse (la vista
  "Activas" vía socket nunca se filtra por turno, a propósito).

**Admin → Dashboard** es el único home del panel - un mapa grande
(`DashboardSection.tsx`) con toda la operación en tiempo real, igual
que Supervisor pero para todos los proyectos a la vez. Por defecto,
al entrar, el alcance elegido es **"Global"** (todo mezclado, sin
proyecto - ni una lista vacía ni una pantalla en blanco pidiendo
elegir algo primero); elegir un proyecto específico en el selector de
arriba acota el mapa, las métricas y todos los overlays a ese
proyecto únicamente. Un Encargado de Proyecto no ve el selector -
siempre es su propio proyecto, nunca "Global" (esa vista es exclusiva
de Admin, el único rol con más de un proyecto a la vez).

Arriba del mapa, una barra de herramientas con el selector de alcance
(Global / "Administradores globales" - usuarios con `project_id =
NULL` / "Dispositivos sin asignar" - vehículos con `project_id =
NULL` / cada proyecto real) y botones de acción (Turnos, Dispositivos,
Usuarios, Geocercas, Equipo estático, Mapas - las 6 disponibles tanto
para Admin como para Encargado de Proyecto, acotadas a su propio
proyecto en el segundo caso) que abren un overlay (`Modal size="large"`,
en `@gaga-gps/ui`)
con la lista/tabla filtrable de ese recurso, ya acotada al alcance
elegido - nada de esto vive permanentemente en pantalla, así el mapa
sigue siendo el protagonista. Debajo de la barra, cuatro tarjetas
(`StatCard`, el mismo componente que ya usaba Supervisor) resumen
dispositivos totales/en línea/geocercas/equipo estático del alcance
actual - en Global son los totales de toda la operación, en un
proyecto específico son solo los suyos.

**Crear o editar una geocerca o equipo estático es la única excepción**
a "todo vive en un overlay": ambos necesitan interacción real con el
mapa (fijar un centro/marcador con clic o arrastre, dibujar un
polígono/ruta con `MapboxDraw`) que un backdrop de modal taparía -
por eso su formulario vive en un panel flotante *sobre* el mapa
mismo, abierto desde el botón "+ Nueva geocerca"/"+ Nuevo equipo"
dentro de sus propios overlays "Geocercas"/"Equipo estático" (que
además listan/editan/eliminan - filtrable, sin necesitar el mapa para
eso). Ambos formularios muestran una **vista previa en vivo** sobre
el mapa mientras se edita - radio/ancho de corredor en geocercas,
radio de giro y de seguridad en equipo estático - antes de guardar,
y ambos son completamente editables después: geocercas con modo
`direct_select` de `MapboxDraw` (arrastrar vértices, agregar/quitar),
equipo estático arrastrando su marcador. Equipo estático se
distingue de una geocerca a simple vista por su forma, no solo por
color - siempre son dos anillos concéntricos (núcleo = radio de giro,
anillo punteado exterior = radio de seguridad), un patrón que ninguna
geocerca usa. Con "Global" elegido, ambos formularios piden
explícitamente a qué proyecto pertenece la geocerca/equipo al
crear (no hay forma de inferirlo cuando se está viendo todo a la vez,
y no aplica al editar uno ya existente); con un proyecto específico
elegido, el `projectId` sigue siendo implícito, sin volver a
preguntarlo. Mismo criterio para crear un dispositivo/usuario/mapa
con "Global" elegido - sus overlays de alta ganan un `<select>` de
proyecto que no existe cuando ya hay un proyecto específico elegido
arriba.

**Equipo estático puede vincularse a una tableta** (`<select>`
"Dispositivo vinculado" en su panel de edición) - para maquinaria fija
con un operador propio (una excavadora, no solo un vehículo). Una vez
vinculada, el estado del equipo (`Inactivo`/`En operación`) deja de
ser manual: se deriva automáticamente de si hay un turno de operador
activo en esa tableta ahora mismo (`POST /api/operator-sessions/start`
lo pasa a "en operación", `/end` lo regresa a inactivo) - una sola
fuente de verdad, sin control manual encima que pueda contradecirla.
El operador de esa tableta se ve a sí mismo en su propio mapa como el
equipo (dos anillos, badge "Operando: {nombre}"), no como un vehículo
en movimiento; el resto de la flota lo ve igual - Operador y
Supervisor dibujan las zonas de todo el equipo del proyecto
(`useEquipmentLayer`, antes solo conectado en Admin) y nunca dibujan
un marcador de "vehículo" para una tableta vinculada, para no
duplicar la misma máquina física con dos representaciones distintas
en el mapa. Una tableta solo puede estar vinculada a un equipo a la
vez (índice único en `static_equipment.linked_device_id`); la
detección de si el brazo está realmente girando (`active_swing` vs
`active_pause`, y avisos de seguridad específicos para maquinaria fija
en vez de un vehículo en movimiento) queda pendiente como trabajo
futuro, no implementada todavía.

**Turnos es la única pestaña que no aplica en "Global"** - el backend
exige un proyecto real para listarlos (`shifts.routes.ts`, `400` si
falta `projectId`), así que ese botón solo aparece con un proyecto
específico elegido; Mapas y Dispositivos/Usuarios/Geocercas/Equipo sí
soportan "Global" sin caso especial en el backend (ya devolvían todo
sin filtrar cuando Admin no manda `projectId`, el mismo patrón usado
desde la Fase A).

**Dispositivos no depende de turno** - un vehículo pertenece al
proyecto (no a un turno específico) y se reutiliza sin importar quién
esté de turno en ese momento; por eso su botón vive junto al de
Turnos, no anidado dentro de él. Los vehículos se auto-registran solos
la primera vez que la tableta manda telemetría a `GET /gps` con un
`unique_id` nuevo (`DeviceRepository.findOrCreate`, sin pasar por el
panel) - nacen con `project_id = NULL`, y "Dispositivos sin asignar"
(con una insignia de conteo cuando hay alguno pendiente, visible tanto
en el selector como en el overlay de Proyectos) es donde Admin los
encuentra para asignarlos a un proyecto editándolos ahí mismo.
Encargado de Proyecto ve/edita los dispositivos de su proyecto igual
que ya podía con turnos/usuarios, pero crear y eliminar sigue siendo
exclusivo de Admin (`devices.routes.ts`, sin cambios - solo cambió
dónde vive la UI).

**Turnos programados** (`shifts` - horario recurrente diario por
proyecto, ej. "Matutino" 07:00–15:00; no confundir con
`operator_sessions`, el turno individual operador+vehículo):
- El Encargado de Proyecto los crea y les asigna un Supervisor de
  Proyecto (Admin → Dashboard, botón "Turnos", con el proyecto
  elegido) - el supervisor no elige, solo inicia sesión y ve
  automáticamente lo que le tocó.
- Al iniciar un turno de operador (`POST /api/operator-sessions/start`),
  `ShiftResolverService` resuelve solo con la hora actual a qué turno
  programado pertenece (maneja el caso que cruza medianoche,
  `end_time < start_time`) y completa `shift_id` - el operador no
  elige nada.
- `GET /api/shifts/mine` - lo que consulta el panel de un Supervisor
  de Proyecto (`useMyShift.ts`, refresco cada 20s) para saber el
  roster (dispositivos/operadores activos) de su turno asignado;
  `SupervisorApp.tsx` filtra `fleet`/lista de vehículos a esos
  `deviceId` - el mapa y las tarjetas de vehículo, no las alertas
  activas (ver "pendiente" más abajo, siguen sin filtrar por
  proyecto/turno a nivel interno).
- **Requiere que el proceso del backend corra en la hora local real**
  (`TZ=America/Mexico_City` en `docker-compose.yml`) - sin esto, Node
  compara contra UTC y un turno "07:00–15:00" configurado pensando en
  hora de Colima quedaría desfasado 6h. Mismo criterio ya aplicado a
  la zona horaria de PostgreSQL.

**Cómo se aplica el aislamiento:**
- **JWT** - `AuthTokenPayload.projectId` (`auth.middleware.ts`); se
  revalida contra PostgreSQL en cada request/conexión, igual que el
  rol - si el Admin reasigna a alguien de proyecto, su sesión anterior
  deja de ser válida de inmediato (fuerza reautenticación), no espera
  a que expire el token.
- **Socket.IO - salas nativas, no un filtro por mensaje**: al
  conectar, cada socket se une a `project:<id>` (o a `role:admin`,
  que recibe todo, solo para el rol `admin`). `FleetSocketServer.broadcastToProject()`
  emite solo a esas salas - un dispositivo sin proyecto asignado
  (`project_id` NULL) solo lo ve el Admin, nunca "por accidente" un
  rol de proyecto mal configurado.
- **REST** - cada ruta de listado (`/api/devices`, `/api/users`,
  `/api/geofences`, `/api/equipment`) filtra por `req.user.projectId`
  cuando no es `null`; Admin (`null`) siempre ve todo sin filtrar.
- **Verificado en vivo** (Docker): dos proyectos de prueba, un socket
  por cada uno - el socket del proyecto 1 no recibió ningún evento
  del dispositivo del proyecto 2, y viceversa; confirmado también a
  nivel REST (`GET /api/devices` de un usuario nunca incluye
  dispositivos de otro proyecto).

**Pendiente explícito (no cerrado, para no romper comportamiento ya
probado):**
- `GeofenceAlertService`, `CollisionRiskService`,
  `VehicleProximityService`, `StaticEquipmentManager` y
  `PreventiveStopService` (parada preventiva colectiva) siguen
  evaluando/emitiendo **globalmente** en memoria - el aislamiento por
  proyecto ya cubre la lista/edición (REST) y la posición en vivo
  (`fleet:update`), pero una alerta de colisión/geocerca/paro
  preventivo todavía se calcula y transmite sin filtrar por proyecto
  a nivel interno. Escoparlos requiere que cada uno sepa a qué
  proyecto pertenece cada `deviceId` (hoy no lo rastrean) - trabajo de
  una fase dedicada, no de este cambio de fundamento. **Riesgo real
  confirmado en pruebas**: un dispositivo de prueba que deja de
  reportar (p. ej. se elimina sin cerrar su "turno" de señal primero)
  puede disparar una parada preventiva colectiva que afecta a **todos**
  los proyectos, no solo al suyo - verificado en vivo durante la
  prueba de esta fase. Al limpiar dispositivos de prueba, revisar
  `GET /api/fleet/stop/status` y `POST /api/fleet/resume` si aplica.
- Las **alertas activas** que ve un Supervisor de Proyecto en su
  panel (colisión, proximidad, geocercas) siguen siendo las de **todo
  el proyecto**, no solo las de su turno - filtrarlas requeriría que
  esos servicios rastreen `deviceId → shift_id`, lo mismo que ya
  detiene el filtrado por proyecto de esta lista (ver arriba). El
  mapa/lista de vehículos sí está correctamente acotado a su turno.
- **Al asignar un usuario existente a un proyecto** (o cambiarle el
  rol), su sesión ya iniciada deja de ser válida de inmediato - es el
  mismo comportamiento que ya existía para cambios de rol, ahora
  también cubre el proyecto. Al migrar cuentas ya existentes a este
  modelo, hay que volver a iniciar sesión una vez.

### Alertas de incidente en tiempo real (estilo Waze/Uber)

Un operador reporta un peligro (objeto en el camino, accidente,
tráfico) desde su posición actual - botón nuevo en el panel de
Operador junto a centrar/auto-seguimiento. Se marca un círculo (radio
real, 120m por default) en el mapa de los demás vehículos del mismo
proyecto, alerta a quien se acerque, y queda visible para
Supervisor/Encargado hasta que alguien lo marca como resuelto.

A diferencia de los servicios de alerta ya existentes (todavía
globales, ver arriba), `IncidentAlertService` nace **ya aislado por
proyecto desde el día uno** - cada incidente trae su propio
`project_id` (resuelto del lado del servidor a partir del dispositivo
que reporta, nunca confiando en lo que mande el cliente), así que
`evaluate()` simplemente descarta cualquier incidente que no sea del
mismo proyecto que la posición entrante, sin necesitar rastrear nada
aparte. Usa `broadcastToProject`, no `io.emit` global.

- `POST /api/incidents` - cualquier operador autenticado.
- `POST /api/incidents/:id/resolve` - Admin, Supervisor, Encargado o
  Supervisor de Proyecto; botón "Resolver" nuevo en `AlertBanner`
  (`packages/ui`), el único elemento de UI genuinamente nuevo de esta
  fase - se conecta al mismo modelo de alertas activas que ya
  usa Supervisor (`useSupervisorSocket.ts`, `Record<string, AlertEntry>`).
- Eventos: `incident:reported`/`resolved` (marcador en el mapa, todos
  los vehículos del proyecto), `incident:nearby` (aviso dirigido solo
  al vehículo que se acerca, con sonido - mismo patrón que
  `proximity:warning`), `supervisor:incident` (nivel 1/0, alimenta la
  lista de alertas activas).
- Se hidrata al conectar (como geocercas) - un cliente que se conecta
  tarde no se pierde los incidentes ya abiertos.
- Verificado en vivo (Docker): reportar → llega el marcador +
  alerta de supervisor nivel 1 → acercar un segundo dispositivo →
  llega `incident:nearby` solo a ese dispositivo → resolver → llega
  `incident:resolved` + alerta de supervisor nivel 0.
- **Marcador de dos anillos** (`incidentLayer.ts`, `packages/map-core`)
  - feedback de prueba en campo: un solo círculo del `radiusMeters`
  real no distinguía a simple vista el punto exacto reportado dentro
  de una zona de ~100m. Ahora hay un **núcleo fijo de 15m, rojo sólido**
  (el punto exacto) además del anillo exterior de siempre (el
  `radiusMeters` real, punteado, color según categoría - sigue siendo
  la zona que dispara `incident:nearby`, sin cambios ahí). El núcleo es
  puramente visual - no se guarda por incidente, no afecta el disparo
  de la alerta. El valor de `radiusMeters` (120m default) sigue sin
  tocarse - pendiente de evaluar con el equipo si es demasiado grande
  para el caso de uso real.
- ~~Bug: la lista "Alertas activas" de Supervisor perdía los
  incidentes ya abiertos al recargar la página~~ **corregido** - la
  hidratación al conectar (`FleetSocketServer.ts`) solo reemitía
  `incident:reported` (marcador del mapa), nunca `supervisor:incident`
  (la lista con el botón "Resolver"). El marcador sobrevivía a una
  recarga, la entrada en la lista no. Ahora ambos eventos se emiten
  juntos al conectar, reutilizando `toPublicShape()` de
  `IncidentAlertService` para no duplicar la normalización del `id`.

### Historial de alertas (Activas + Historial con filtros)

Ninguna alerta "normal" (geocerca, señal perdida, colisión,
proximidad, parada preventiva) sobrevivía a un reload del panel de
Supervisor - solo existían como estado en memoria del navegador
(`activeAlerts`), sin ninguna tabla detrás (a diferencia de
incidentes, que ya tenían `incident_reports`). Se agregó
`alert_events` - una sola tabla que **cada uno de los 6 servicios de
alerta** escribe además de emitir su evento de socket de siempre
(mismo patrón que ya usaba `GeofenceAlertService` → `geofence_events`,
generalizado): `id`, `project_id` (resuelto del dispositivo, `NULL`
solo en parada preventiva - evento global de toda la flota),
`alert_type`, `severity`, `device_id`/`device_id_2` (par de vehículos
en colisión/proximidad), `message`, `metadata` (jsonb - distancia,
nombre de geocerca, id/categoría de incidente), `triggered_at`,
`resolved_at` (`NULL` mientras sigue activa).

- **`AlertEventRepository.recordOrEscalate()`** - si ya hay una fila
  abierta para el mismo `(alertType, deviceId, deviceId2)`, la
  actualiza (severidad/mensaje) en vez de duplicarla, así una
  escalada (ej. señal perdida nivel1→nivel2) no deja un "fantasma"
  abierto para siempre al resolverse solo el último nivel. Incidentes
  usan un par de métodos dedicados (`recordIncident`/`resolveIncident`,
  matchean por el propio id del incidente, no por dispositivo) porque
  un mismo vehículo puede tener varios incidentes distintos abiertos
  a la vez - el matching genérico por deviceId los fusionaría.
- **"Activas" sobrevive a un reload** - al conectar, `FleetSocketServer`
  emite `alerts:snapshot` con `findActive()` (excluye incidentes, esos
  ya se hidratan aparte); el frontend repuebla `activeAlerts` con la
  misma clave que ya usan los eventos en vivo (`geofence:${deviceId}`,
  `pairKey('collision', ...)`, etc.) para no duplicar entradas.
- **"Historial"** - `GET /api/alerts/history` (filtros `type`,
  `severity`, `deviceId`, `from`, `to`) y `/history/csv` (exportación,
  mismo patrón de `reports.routes.ts`), acotado por proyecto (Admin ve
  todo; el resto de roles su propio proyecto + las filas
  `project_id IS NULL` de parada preventiva, igual que ya hace
  `broadcastToProject` en vivo). Toggle "Activas"/"Historial" en la
  misma tarjeta que ya existía, sin sección nueva en el nav. Para
  `project_supervisor` específicamente, `from` además se acota hacia
  arriba (nunca hacia abajo de lo que el propio caller pida) al inicio
  de su turno más reciente
  (`ShiftResolverService.mostRecentShiftStartForSupervisor`) - ve su
  propio historial de alertas, no el de todo el proyecto ni el de
  turnos anteriores. La vista "Activas" (vía socket, no esta ruta)
  nunca se acota por turno a propósito - una alerta que sigue abierta
  desde antes de que empezara su turno debe seguir visible hasta
  resolverse.
- Verificado en vivo (Docker) contra los 6 tipos de alerta con
  dispositivos de prueba: geocerca (entrada/salida), señal perdida
  (nivel 2 real, esperando el timeout), parada preventiva (disparo
  automático + manual), proximidad (crítica y su resolución),
  incidente (reporte + resolución) - colisión no se disparó en vivo
  (exige trayectorias convergentes, más difícil de simular con curl)
  pero usa exactamente el mismo código de instrumentación que
  proximidad, ya verificado. `alerts:snapshot` confirmado trayendo de
  vuelta una alerta abierta a un socket que se conecta después del
  disparo; filtros y CSV confirmados; aislamiento por proyecto
  confirmado (un supervisor de un proyecto no ve las filas de otro).

## Eliminar un proyecto - qué pasa con lo que tenía dentro

Eliminar un proyecto (`DELETE /api/projects/:id`, Admin → Dashboard →
"Gestionar proyectos") es destructivo para algunos datos y no para
otros - decisión explícita del usuario, para no dejar huérfanos datos
que ya no pertenecen a ningún proyecto:

- **Se eliminan de verdad** (no hay forma de recuperarlos): turnos
  (`shifts`), geocercas, equipo estático, incidentes
  (`incident_reports`) y el historial de alertas (`alert_events`) del
  proyecto. Los archivos `.mbtiles` de sus mapas también se borran del
  filesystem (`ProjectRepository` no toca archivos - la limpieza vive
  en `projects.routes.ts`, reutilizando `MapPipelineService`, igual
  que al eliminar un mapa individual, pero sin el guard de "no borrar
  si está activo": el proyecto entero se va, no tiene sentido
  bloquear por eso).
- **Nunca se eliminan**: usuarios y dispositivos. Se desvinculan
  (`project_id = NULL`) en vez de borrarse, para no perder la cuenta
  ni el historial de telemetría de un vehículo real. Los usuarios
  además se **desactivan** (`active = false`, mismo efecto que si un
  admin los deshabilitara a mano) porque ya no pertenecen a ningún
  proyecto operativo; los dispositivos no tienen un concepto de
  "activo/inactivo" en el schema, así que solo quedan sin proyecto
  asignado - aparecen listados primero (antes que los ya asignados) en
  el overlay "Dispositivos" con cualquier alcance elegido, para
  encontrarlos fácil y reasignarlos.
- Todo corre en una sola transacción SQL (`ProjectRepository.delete`,
  mismo patrón `BEGIN`/`COMMIT`/`ROLLBACK` que ya usaba
  `DeviceRepository.delete({ force: true })`) - o se aplican todos los
  cambios o ninguno, nunca un estado a medias si algo falla a mitad de
  camino.
- El panel exige escribir el nombre exacto del proyecto para
  confirmar (no un simple "¿Está seguro?"), y el mensaje de
  confirmación enumera explícitamente qué se borra y qué solo se
  desvincula, para que no sea una sorpresa.
- `ProjectHasDependentsError` (409) sigue existiendo como red de
  seguridad, no como el camino esperado - solo debería lanzarse si una
  tabla nueva agrega `REFERENCES projects(id)` sin que `delete()` se
  actualice para cubrirla explícitamente (el `NO ACTION` por defecto
  de la FK en Postgres seguiría bloqueando el `DELETE` crudo en ese
  caso).

## Panel de administración

Accesible en `/admin` (rol `admin`) o `/encargado` (rol `project_manager`,
mismo componente con menos alcance - ver [Autenticación y roles](#autenticación-y-roles))
tras iniciar sesión en el login único (`/`; ver
[Instalación y despliegue](#instalación-y-despliegue) para crear el
primer usuario). Secciones:

- **Dashboard** - home único: mapa grande con toda la operación en
  tiempo real ("Global" por defecto, o un proyecto elegido) + resumen
  de métricas + overlays de Proyectos/Turnos/Dispositivos/Usuarios/
  Geocercas/Equipo estático/Mapas - ver
  [Multi-tenencia por proyecto](#multi-tenencia-por-proyecto) para el
  detalle completo del layout y del flujo. El `<select>` de rol al
  crear/editar un usuario lista `operator`/`project_supervisor`/
  `project_manager`/`admin` hoy, pero el backend ya no restringe los
  roles posibles (ver [Autenticación y roles](#autenticación-y-roles))
  - agregar uno nuevo es editar esa lista, no una migración.
- **Reportes** - exportación a CSV.
- **Sistema** - health check en vivo.

Historial (consulta de posiciones pasadas por dispositivo y rango de
fechas) ya no es una sección propia - es un modo dentro de Dashboard,
ver [Visor de recorridos por día](#visor-de-recorridos-por-día).

## Panel de Operador y Supervisor

**Principio de diseño - local complementa, nunca reemplaza:** para el
propio vehículo del operador, todo lo que el navegador puede leer
localmente (posición, rumbo, velocidad, vehículo más cercano) tiene
prioridad sobre el dato que llega por servidor - respuesta inmediata,
funciona sin conexión, y sigue funcionando igual de bien conectado.
Pero el servidor sigue siendo indispensable para todo lo que el
navegador **no puede ver por sí solo**: el resto de la flota, alertas
de colisión/proximidad (siguen siendo decisión exclusiva del backend,
nunca del cliente), geocercas, mapas satelitales y turnos. Ningún dato
local sustituye a esto - solo se adelanta el propio, mientras el
servidor completa todo lo demás. Traccar Client sigue siendo, y
seguirá siendo, la única fuente que ve el resto de conductores/supervisor
sobre este vehículo - lo local es exclusivamente para la pantalla del
propio operador.

¿Hay diferencia entre cómo Traccar Client formatea/envía la posición y
cómo la lee el navegador? En la práctica, no debería: ambos leen del
mismo proveedor de ubicación de Android (el mismo mock-location que
inyecta GNSS Master llega igual a Traccar y a Chrome) - mismas
unidades (velocidad en m/s, rumbo en grados 0-360, precisión en
metros), mismo reloj del sistema para el timestamp. Verificado en vivo
durante pruebas con RTK/NTRIP conectado: posiciones casi idénticas
(diferencia de centímetros) entre lo que reportó Traccar y lo que leyó
el navegador en el mismo instante. La única diferencia real es de
*muestreo* (cada canal consulta al proveedor de forma independiente,
puede tomar el fix en un milisegundo distinto), no de formato - y
ambos pasan por la misma lógica anti-teletransporte (ver
"Continuidad offline" más abajo), así que un glitch de fix/float del
RTK se filtra igual en los dos lados.

**Mapa (Operador y Supervisor):**
- Flecha de rumbo en cada marcador (`packages/map-core/src/vehicleMarker.ts`), a partir de `course` - es el **rumbo de desplazamiento real** que calcula el propio GPS/RTK (dirección en la que el vehículo se está moviendo, medida por los fixes sucesivos), no la brújula/orientación física del dispositivo. Por eso ya refleja correctamente ir en reversa: si el vehículo retrocede, `course` apunta hacia atrás porque es hacia ahí donde en realidad se está desplazando, sin importar hacia dónde "mire" la tableta. Se atenúa (no desaparece) cuando el vehículo está detenido, porque a velocidad ~0 ese dato es ruido, no rumbo real.
- Para el propio vehículo del Operador, el rumbo usa directamente `useDeviceGeolocation` (sensor del navegador) en vez de esperar el viaje de ida y vuelta al servidor - respuesta inmediata, no la del último fix que llegó por socket.
- **Glide entre posiciones** (`MapView.tsx`, `glideMarkerTo`) - los marcadores ya no saltan de golpe con cada fix nuevo; se animan con `requestAnimationFrame` desde la posición anterior a la nueva, en el mismo intervalo que tardó el fix anterior en llegar (así el movimiento se ve continuo, estilo Google Maps/Uber, sin adelantarse a datos reales ni acumular retraso). No pelea con el pan/zoom del mapa porque solo llama a `marker.setLngLat(...)` en cada frame - la misma API que usaría una actualización normal.
- Zonas de estacionamiento - geocerca tipo `parking` (azul), solo admin puede crearlas, sin sirena.
- Marcador "amenaza" con halo pulsante durante una alerta activa de proximidad/colisión; geocerca activa resaltada con pulso.
- Auto-seguimiento (botón , persiste en `localStorage`) - sigue la posición propia sin forzar zoom; se apaga solo si el operador interactúa manualmente con el mapa. Al entrar una amenaza crítica, encuadra ambos vehículos por unos segundos antes de retomar el seguimiento normal.
- "Más cercano" en el HUD del Operador se recalcula en el cliente (`packages/map-core/src/geometry.ts`, Haversine) usando la posición **local** propia contra la última posición conocida de cada vehículo - no espera el siguiente `proximity:distance_update` del servidor. Si esa última posición del otro vehículo ya es vieja (>10s, mismo umbral que el resto del sistema), se marca "(sin señal)" junto a la distancia. La alerta de proximidad/colisión en sí (sonido, banner, halo) sigue siendo la que dispara el servidor - esto solo adelanta el número informativo del HUD.

**Continuidad offline (Operador):**
La posición/velocidad propia ya no depende de la ida y vuelta al
servidor - `useDeviceGeolocation.ts` usa la Geolocation API del
navegador (`watchPosition`) como fuente primaria para "mi" marcador y
HUD, funcionando incluso sin conexión. El resto de la flota sigue
viniendo del servidor (no hay forma de verla sin conexión). Además:
- Indicador propio "GPS local" en la barra superior, independiente de "Conectado al servidor".
- Batería del dispositivo vía Battery Status API (`useBatteryLevel.ts`), cuando el navegador la expone.
- Si el socket se cae más de 10s/20s, una alerta local (sin depender del servidor) avisa reducir velocidad / detenerse - mismos umbrales que `SignalLostService`.
- **Filtro anti-teletransporte también en el navegador** - cada fix que entrega `watchPosition` pasa por una copia de `PositionFilterService` (`packages/map-core/src/positionFilter.ts`) antes de aceptarse. Sin esto, un salto físicamente implausible (glitch fix/float del RTK) que el backend ya descarta para lo que ve el resto de la flota se seguiría mostrando sin filtrar en la pantalla del propio operador - más visible todavía ahora que el marcador anima ("glide") entre posiciones. Misma lógica que la copia del backend (`apps/backend/src/services/telemetry/PositionFilterService.ts`); no comparten un paquete en común porque el backend no puede depender de `map-core` (trae React/MapLibre) - si se ajusta el criterio en un lado, replicar en el otro.
- Es una solución puente en el navegador; RTK y anti-spoofing quedan para la futura app móvil nativa.

**Captura extendida de sensores del navegador (Operador):**
Traccar Client es una app nativa - solo manda lat/lon/velocidad/rumbo/precisión/batería
por el protocolo OsmAnd (`/gps`), a la frecuencia que tenga configurada
en la propia app (hoy 1 fix/segundo con el RTK conectado - es ajuste
de Traccar, no del backend). Todo lo demás que el navegador puede ver
(red, memoria, pantalla, orientación/movimiento, almacenamiento) viaja
por un canal separado: `useDeviceSensorReporter.ts` → `POST
/api/devices/:deviceId/sensors` → hypertable JSONB propia
`device_sensor_snapshots` (independiente de `positions`; compresión a
1 día, retención 30 días - son datos exploratorios, no historial
operativo). Consulta de verificación (admin/supervisor): `GET
/api/devices/:deviceId/sensors?limit=50`.

Optimizado en dos niveles para no duplicar ni repetir dato inútil:
- **Perfil fijo, una sola vez por sesión** (`source='browser_profile'`):
  `userAgent`, `platform`, `language(s)`, `hardwareConcurrency`,
  `deviceMemoryGb` - no cambian dentro de una misma sesión, no tiene
  sentido repetirlos cada ciclo.
- **Snapshot variable, cada 30s** (`source='browser'`): `network`,
  `battery`, `screen`, `storage`, `deviceOrientation`/`deviceMotion`,
  `onLine`, `visibilityState` - sí cambian, pero no lo bastante rápido
  como para necesitar 1Hz (batería/red no se mueven en 1 segundo).
- **Sin `geolocation` en este snapshot** - lat/lon/precisión/altitud/
  rumbo/velocidad del propio dispositivo ya quedan en `positions` a la
  frecuencia real del GPS/RTK (vía Traccar); guardarlos otra vez aquí
  cada 30s sería el mismo dato dos veces sin ganar nada.

**Zona horaria de la base de datos:** fijada a `America/Mexico_City`
(`ALTER DATABASE gaga_gps SET timezone ...` en `001_init.sql`, aplica
también a cualquier instalación nueva) - la operación es de un solo
sitio (Colima), así que cualquier consulta directa por psql/DBeaver
muestra la hora local en vez de UTC. No afecta lo guardado ni al
backend: `TIMESTAMPTZ` siempre representa el mismo instante real sin
importar la zona de sesión, y el driver `pg` nunca formatea fechas
como texto.

**Panel de Administración** - mismo rediseño visual/paleta que
Operador y Supervisor (`admin.css`, sin tocar la lógica de ninguna
sección). Nav lateral de ancho fijo pasa a franja horizontal con
scroll bajo 860px, en vez de robarle ancho al contenido. Las tarjetas
de métricas del dashboard usan grid (`.card:has(.metric)`) en vez de
`inline-block`, que dejaba huecos irregulares al envolver. Cero
emojis - incluye el selector de modo de mapa compartido
(`MapModeSelector`, `packages/ui`), que también los tenía y afectaba
de paso a Operador/Supervisor.

**Panel de Supervisor** - ajustes adicionales de espacio/adaptabilidad
sobre el rediseño ya existente, sin quitar ningún dato (sigue
mostrando el detalle completo de cada vehículo): panel lateral con
ancho fluido (`clamp()`) en vez de fijo, panel flotante de detalle con
`max-height`/scroll propio para que nunca se corte información en
pantallas bajas, y en pantallas angostas el layout pasa de columnas a
panel superior + mapa abajo (mismo criterio que la nav de Admin).

**Panel de Operador** - mismo rediseño visual que Supervisor (paleta
oscura neutra compartida vía `packages/ui/src/tokens.ts`, sin neón ni
emojis). Estructura por flexbox real en vez de posiciones fijas
adivinadas: encabezado (identidad + acciones en una fila, estado de
conexión/GPS en otra, ambas con `flex-wrap` para no recortarse en
pantallas angostas), área de mapa flexible (selector de modo y
botones flotantes de centrado/auto-seguimiento viven **dentro** de esa
misma caja, nunca pueden quedar por encima de la barra inferior sin
importar cuántas filas ocupe), y barra de HUD inferior en grid
(`repeat(auto-fit, minmax(...))`) que se reacomoda sola en vez de
comprimir texto - pensado para 7" pero sin ningún tamaño fijo que
rompa en otras resoluciones. Los iconos de centrado/auto-seguimiento
pasaron de emoji a SVG inline.

**Panel de Supervisor** - rediseño visual (paleta oscura neutra, sin
neón ni emojis, secciones con bordes y contraste claros) y modelo de
alertas nuevo: en vez de una lista que crece con cada re-disparo de
la misma alerta (`useSupervisorSocket.ts` antes hacía `addAlert` en
cada evento), ahora se mantiene un mapa de **alertas activas**
(`Record<string, AlertEntry>`), una por clave estable
(`colisión:V1-V2`, `señal:V3`, `geocerca:V4`, `paro_preventivo`) - un
nuevo disparo de la misma alerta actualiza la entrada existente en
vez de duplicarla, y desaparece sola cuando el evento `nivel 0`/
"resuelto" llega. El contador de "Alertas" ahora es simplemente el
tamaño de ese mapa (antes solo subía). Al seleccionar un vehículo:
- Operador con turno activo (nombre, hora de inicio) vía `/api/operator-sessions/active`.
- Rumbo, precisión GPS, altitud y batería, además de velocidad/posición.
- El estado online/offline se calcula en el cliente contra `lastSeen` (nunca confía en un campo persistido) - ver siguiente sección para el equivalente en Admin.

**Panel de administración - estado online/offline corregido:**
`devices.status` se quedaba en `'online'` para siempre tras el primer
reporte (`DeviceManager.markOffline` existía pero nunca se llamaba).
Ahora `SignalLostService` lo marca `offline` al entrar a nivel 1 o 2,
y al arrancar el backend siembra su reloj de última señal desde
`devices.last_update` (`hydrate()`) para no "olvidar" dispositivos ya
inactivos antes de un reinicio.

## Acceso directo a PostgreSQL y Redis

**PostgreSQL** (contenedor `gaga-postgres`, puerto `5432`):

```bash
docker exec -it gaga-postgres psql -U gaga_app -d gaga_gps
```

```sql
\dt                                          -- listar tablas
SELECT * FROM devices;
SELECT * FROM positions ORDER BY fix_time DESC LIMIT 20;
```

También puedes usar un cliente gráfico (DBeaver, pgAdmin) con host
`localhost`, puerto `5432`, base `gaga_gps`, usuario/contraseña de
tu `.env`.

**Redis** (contenedor `gaga-redis`, puerto `6379`) - solo contiene
el estado en tiempo real de la flota, no histórico:

```bash
docker exec -it gaga-redis redis-cli -a <REDIS_PASSWORD>
```

```
HGETALL gaga:fleet:state     # estado actual de toda la flota (JSON por dispositivo)
```

## Solución de problemas comunes

| Síntoma                                                                                               | Causa probable                                                                                                                                                                                                                                      | Solución                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOAUTH Authentication required` (Redis)                                                              | Falta `REDIS_PASSWORD` en `.env`                                                                                                                                                                                                                    | Debe coincidir con lo que arrancó el contenedor `gaga-redis` (`docker compose up -d --build` para aplicar cambios de `.env`)                                                                                                                                                     |
| `Cannot GET /`, `/admin`, `/operator`, `/supervisor`                                                  | El build de `apps/web-app` no llegó a la imagen del backend, o falta el fallback de SPA                                                                                                                                                             | Verificar que `apps/web-app/dist` exista tras `npm run build` (lo copia la etapa `runtime` de `apps/backend/Dockerfile`); confirmar que `app.ts` tiene el `app.get(/^\/(?!api\|gps\|tiles\|health\|socket\.io).*/, ...)` al final, después de todas las demás rutas              |
| Entrar a `/admin`, `/supervisor` u `/operator` directo manda de vuelta al login (`/`) en loop         | No hay sesión válida en `localStorage`, o el rol del usuario no coincide con esa ruta (`ProtectedRoute` redirige si no coincide)                                                                                                                    | Es el comportamiento esperado - inicia sesión en `/` con un usuario de ese rol. Si el loop persiste con credenciales correctas, revisar la consola del navegador por errores de red a `/api/auth/login`                                                                          |
| `401`/`403` en `/api/fleet/stop` o `/resume` con un usuario logueado                                   | El usuario no tiene un rol autorizado (`requireRole('supervisor', 'admin', 'project_supervisor', 'project_manager')`), o el token venció                                                                                                            | Confirmar el rol del usuario en Admin → Dashboard → overlay Usuarios; si el rol es correcto pero sigue fallando, volver a iniciar sesión (el token pudo expirar)                                                                                                              |
| El socket no conecta / no llegan actualizaciones en vivo en Supervisor u Operador                     | `io.use(buildSocketAuthMiddleware(...))` rechaza conexiones sin un JWT válido - antes los sockets eran abiertos                                                                                                                                     | Confirmar que hay una sesión válida en `localStorage` (`gaga_auth_token`) antes de que la app llame a `createSocket()`; en herramientas manuales (`test-client.js`) hacer login por HTTP primero para obtener el token                                                           |
| `404` en Traccar Client al mandar posición                                                            | La tableta usa `POST` en vez de `GET`                                                                                                                                                                                                               | Ya soportado - verificar que el backend esté actualizado (`router.post('/gps', ...)` en `telemetry.routes.ts`)                                                                                                                                                                   |
| `400` "Faltan parámetros requeridos" pese a que la tableta manda datos                                | Traccar Client envía los parámetros en el body (`form-urlencoded`), no en la URL                                                                                                                                                                    | Ya soportado - requiere `express.urlencoded()` en `app.ts`                                                                                                                                                                                                                       |
| `DELETE /api/devices/:id` responde 409                                                                | El dispositivo tiene historial de posiciones (caso normal)                                                                                                                                                                                          | Usar `?force=true` si de verdad quieres purgar también el historial                                                                                                                                                                                                              |
| Vehículo aparece en el mapa con nombre igual a su ID técnico                                          | El dispositivo se auto-registró (nunca se le puso un nombre amigable)                                                                                                                                                                               | Editar el nombre desde Admin → Dashboard → overlay Dispositivos (buscar en "Dispositivos sin asignar" si aún no tiene proyecto)                                                                                                                                              |
| El backend arranca pero dice `degraded` en `/health`                                                  | PostgreSQL o Redis no están accesibles con las credenciales del `.env`                                                                                                                                                                              | Revisar `docker compose logs gaga-backend`; si corres el backend fuera de Docker (flujo avanzado), confirma que Postgres/Redis estén expuestos en `localhost` (`docker compose up -d postgres redis`) - son los defaults del código si `DB_HOST`/`REDIS_HOST` no están definidos |
| El backend falla al arrancar con "Configuración insegura"                                             | Falta `JWT_SECRET` o `TELEMETRY_SHARED_SECRET` en `.env` y `NODE_ENV=production`                                                                                                                                                                    | Completar ambas variables en `.env` - son obligatorias en `NODE_ENV=production`                                                                                                                                                                                                  |
| `docker compose up -d --build` falla compilando `better-sqlite3`                                      | Faltan herramientas de build en la imagen                                                                                                                                                                                                           | Ya cubierto - `apps/backend/Dockerfile` instala `python3 make g++` en la etapa de dependencias                                                                                                                                                                                   |
| `docker compose up -d --build` falla en `tsc --noEmit` o `vite build`                                 | Un cambio de código rompió el tipado de TypeScript en el backend o en `apps/web-app`                                                                                                                                                                | El log de build de Docker señala el archivo y la línea exactas - corregir ahí; correr `npm run build` en local antes de reconstruir la imagen para iterar más rápido                                                                                                             |
| `gaga-backend` se queda "unhealthy"/reiniciando en bucle                                              | Postgres/Redis aún no listos, o credenciales no coinciden                                                                                                                                                                                           | Revisar `docker compose logs gaga-backend`; confirmar que `.env` tiene las contraseñas correctas y coincide con el contenedor ya arrancado                                                                                                                                       |
| Los `.mbtiles` no aparecen en `/tiles` tras el deploy                                                 | El mapa no se importó (o no se activó) desde el panel Admin en este entorno - el volumen `maps_data` es propio de cada stack/servidor                                                                                                               | Importar y activar el mapa desde Admin → Dashboard → overlay Mapas (con el proyecto correcto elegido) en ese entorno; los `.mbtiles` no se comparten entre despliegues distintos                                                                                             |
| Clonaste el repo de nuevo y aparece como instalación limpia (sin dispositivos/usuarios que ya tenías) | El proyecto de Docker Compose se resolvió con otro nombre (por defecto viene del nombre de la carpeta) y creó volúmenes nuevos y vacíos - ver [Persistencia de datos](#persistencia-de-datos--instalación-limpia-vs-actualización-vs-borrado-total) | Los datos viejos probablemente siguen en un volumen huérfano - revisa `docker volume ls`, busca `<carpeta-vieja>_postgres_data`. `docker-compose.yml` ya fija `name: gaga-gps-001` para que esto no vuelva a pasar sin importar el nombre de la carpeta                          |

| No se emite el certificado HTTPS | DNS de alguno de los dos dominios no apunta al host, o el puerto público 80/443 está bloqueado | Crear los registros A/AAAA para `gaga-maquinaria.com` y `app.gaga-maquinaria.com` hacia el servidor y abrir `80/tcp` y `443/tcp` |

## Limitaciones conocidas / trabajo futuro

- **Admin no puede tener proyecto asignado** - `project_id = NULL` es
  el único alcance válido para el rol Admin (ver
  [Multi-tenencia por proyecto](#multi-tenencia-por-proyecto)). El
  `<select>` de Proyecto en Admin → Dashboard → overlay Usuarios se
  deshabilita y se limpia solo en cuanto el Rol elegido es "Admin", y
  `users.routes.ts` (POST/PATCH) fuerza `projectId: null` del lado
  del servidor cuando el rol efectivo es admin sin confiar en lo que
  mande el cliente - la ruta es la única verdad, la UI es solo
  comodidad (mismo criterio ya usado para "no dejar el sistema sin
  ningún admin activo").
- ~~Bug: eliminar un usuario purgaba solo `operator_sessions` con
  `force=true`, pero `shifts.supervisor_user_id` e
  `incident_reports.reported_by`/`resolved_by` (las otras 3 FK reales
  a `users(id)`) seguían bloqueando el `DELETE` con 23503~~
  **corregido** - a diferencia de un dispositivo (donde purgar todo
  el historial tiene sentido, es telemetría propia del dispositivo),
  un turno o un incidente **no son datos del usuario**, solo lo
  referencian de paso como supervisor/reportero - borrarlos habría
  destruido información real sin necesidad. Ahora esas 3 columnas se
  desvinculan (`UPDATE ... SET ... = NULL`) en vez de bloquear o
  eliminar la fila que las contiene, mismo criterio que
  `maps.uploaded_by` (que ya tenía `ON DELETE SET NULL` en el schema).
  El diálogo de confirmación en el panel pasó al mismo patrón "un solo
  aviso + escribir el nombre para confirmar" ya usado para
  proyectos/dispositivos.
- ~~Bug: exportar geocercas (GeoJSON/KML) fallaba en HTTP con "The
  file at 'blob:...' was loaded over an insecure connection"~~
  **corregido** - la exportación hacía `fetch()` + `URL.createObjectURL(blob)`
  + click programado; Chrome bloquea las descargas iniciadas desde un
  `blob:` armado por JS cuando la página no es un contexto seguro
  (HTTPS o `localhost` exacto), como protección anti-abuso (un `blob:`
  evita el escaneo de red que sí aplica a una descarga real). Se
  cambió a un `<a href>` apuntando directo a la URL de descarga - una
  respuesta de red real con `Content-Disposition: attachment` no cae
  en esa restricción. Como un `<a>` no puede mandar un header
  `Authorization`, se agregó `buildDownloadAuthMiddleware` (acepta el
  mismo JWT también por `?token=` en la URL) aplicado únicamente a
  `GET /export.geojson`/`GET /export.kml` - el resto de la API sigue
  exigiendo el header, sin excepciones.
- ~~Bug: eliminar un dispositivo no limpiaba sus alertas activas en
  vivo, solo la base de datos~~ **corregido** - cada uno de los 6
  servicios de alerta (`GeofenceAlertService`, `SignalLostService`,
  `CollisionRiskService`, `VehicleProximityService`,
  `PreventiveStopService`, `IncidentAlertService`) mantiene su propio
  estado en memoria ("esta alerta está activa ahora"), separado de la
  tabla `alert_events` (esa solo alimenta "Activas"/"Historial" del
  panel). `DELETE /api/devices/:id` nunca los tocaba, así que una
  alerta abierta de un dispositivo eliminado quedaba fantasma para
  siempre (nunca se resuelve sola - depende de que el dispositivo
  vuelva a reportar posición). El caso más grave: la hidratación de
  incidentes al conectar (`FleetSocketServer.ts`) lee directo del mapa
  en memoria de `IncidentAlertService`, sin pasar por la base de datos
  - purgar `incident_reports` no tenía ningún efecto ahí. Cada
  servicio ganó un `clearDevice(deviceId)` (colisión/proximidad
  reciben además `otherDeviceIds`, porque su clave de par no se puede
  parsear de vuelta a los dos IDs originales de forma confiable) que
  reutiliza su propio método de resolución existente - un Supervisor
  ya conectado ve la alerta resolverse en vivo, no solo que desaparezca
  en la próxima hidratación. Verificado con un cliente de socket real
  (no alcanza con curl, hay que observar eventos empujados a una
  conexión ya abierta): reportado un incidente de prueba, confirmado
  que `incident:resolved`/`supervisor:incident` llegan al eliminar el
  dispositivo que lo reportó.
- ~~Bug: `DELETE /api/devices/:id?force=true` seguía rechazado con 409
  aunque se mandara `force=true`~~ **corregido** -
  `DeviceRepository.delete({ force: true })` solo purgaba
  `operator_sessions`/`positions` antes de reintentar el `DELETE`, pero
  hay otras dos tablas con FK real a `devices(unique_id)` que también
  bloquean el borrado si tienen filas: `device_sensor_snapshots`
  (sensores del navegador) e `incident_reports` (incidentes reportados
  desde/cerca de ese dispositivo) - ninguna de las dos se purgaba, así
  que cualquier dispositivo con al menos un snapshot o un incidente
  reportado no se podía eliminar ni con `force=true`, aunque el mensaje
  de error sugiriera que sí se podía. Ahora también purga
  `geofence_events` y `alert_events` (sin FK real, pero quedarían
  huérfanas con un `device_id` apuntando a nada) - purga completa del
  historial, no solo lo mínimo para que el `DELETE` no truene. El panel
  (Admin → Dashboard → overlay Dispositivos) de paso pasó a pedir
  escribir el ID exacto del dispositivo para confirmar (antes eran dos
  `confirm()` encadenados - uno genérico, y solo si fallaba con 409 uno
  reactivo preguntando por el historial) y explica de una sola vez, sin
  intentar primero el borrado normal, que se elimina todo el
  historial - mismo criterio ya usado para eliminar un proyecto.
- ~~Bug de `CollisionRiskService` con `Math.min`/deviceId de texto~~
  **corregido** - la clave interna del par ahora se arma ordenando
  los IDs como texto (`[id1, id2].sort().join('-')`), no con
  `Math.min`/`Math.max` (que daba `NaN` para IDs no numéricos y
  colapsaba todos los pares en una sola llave). Junto con este fix
  se corrigió también la limpieza de la alerta: antes dependía de
  "trayectorias convergiendo" en cada tick, lo que causaba parpadeo
  con vehículos casi estáticos (ruido de GPS haciendo que la
  convergencia oscile); ahora solo se limpia cuando la distancia
  realmente crece más allá del umbral (con margen de histéresis). Se
  agregó además `supervisor:collision`/`supervisor:proximity` nivel
  `0` cuando una alerta se resuelve - antes el supervisor nunca se
  enteraba.
- ~~Bug de auto-bloqueo: Admin → Usuarios no tenía guardas contra
  quedarse sin ningún admin activo~~ **corregido** - la tabla de
  Usuarios solo tenía "Desactivar"/"Eliminar" (no "Editar"), y nada
  impedía desactivar, eliminar o cambiarle el rol al único admin
  activo del sistema. Pasó en la práctica: se deshabilitó por
  accidente la cuenta `admin@gaga.com` desde el propio panel,
  bloqueando el acceso hasta corregirlo a mano por SQL directo. Ahora
  `PATCH /api/users/:id` y `DELETE /api/users/:id` rechazan (400) toda
  acción que dejaría el conteo de admins activos en cero
  (`UserRepository.countActiveAdmins`), y la sección de Usuarios ganó
  un botón "Editar" real (email/nombre para cualquiera con permiso de
  gestión; rol/proyecto solo Admin) en vez de solo activar/desactivar.
- ~~Bug de `COALESCE` en `update()` - no se podía limpiar un campo a
  `null` (quitarle el proyecto a un usuario/dispositivo, o el
  supervisor asignado a un turno)~~ **corregido** en
  `UserRepository`, `DeviceRepository` y `ShiftRepository` -
  `COALESCE($n, columna)` no distingue "no mandaron este campo" de
  "lo mandaron explícitamente en `null`" (los dos bindean como
  `NULL` en `pg`), así que un `PATCH` con `projectId: null` se
  ejecutaba sin error pero no cambiaba nada. Los tres `update()`
  ahora arman el `SET` a mano, incluyendo solo las columnas cuya key
  vino en el body (aunque su valor sea `null`). Encontrado en vivo al
  agregar edición de proyecto/dispositivo - `assignSupervisor()` en
  `ShiftsSection.tsx` tenía el mismo bug latente desde la Fase B, sin
  que nadie lo hubiera notado todavía.
- Admin → Proyectos y Admin → Dispositivos ganaron **Editar** real
  (antes Proyectos solo tenía activar/desactivar; Dispositivos no
  tenía edición en absoluto, solo alta y baja). Dispositivos: nombre,
  tipo y proyecto son editables - el `unique_id` (identificador que
  manda Traccar Client) nunca lo es, ni en el formulario ni en el
  backend (`devices.routes.ts` PATCH no lo acepta). Proyectos ganaron
  además **Eliminar**, con confirmación escribiendo el nombre exacto
  del proyecto (no un simple "¿Está seguro?") - ver
  [Eliminar un proyecto](#eliminar-un-proyecto-qué-pasa-con-lo-que-tenía-dentro)
  para el comportamiento real (ya no bloquea con 409 si el proyecto
  tiene datos asociados, los maneja explícitamente).
- **PostGIS** está instalado (`CREATE EXTENSION postgis`) pero
  **no se usa** - todos los cálculos de distancia/geocercas usan
  la fórmula de Haversine en JavaScript sobre columnas
  `DOUBLE PRECISION` planas. Queda disponible para el futuro si se
  requieren geocercas poligonales (`ST_Contains`, tipos `geography`).
- **Importador de mapas** - el modo "Mixto" es una superposición de
  opacidad (satelital sobre calles), no un estilo híbrido con
  etiquetas vectoriales - no hay ninguna fuente de ese tipo disponible
  offline en este proyecto. Tampoco hay cola de procesamiento - una
  importación a la vez.
- **Exportación a PDF** de reportes no está implementada - solo CSV.
- **Estimación de velocidad** - el suavizado es un EMA simple (ver
  [Estimación de velocidad](#estimación-de-velocidad)), no un filtro
  de Kalman con modelo de movimiento; suficiente para corregir picos
  del GPS, pero es un primer nivel, no el óptimo teórico.
- **GPS local del navegador** - es un puente para que Operador
  funcione offline hoy (ver [Panel de Operador y Supervisor](#panel-de-operador-y-supervisor));
  no reemplaza RTK ni detecta mock-location - eso queda para la app
  móvil nativa planeada.
- **Battery Status API** - deprecada/restringida en varios navegadores
  (Chrome de escritorio ya no la expone); el dato de batería en el
  HUD del operador simplemente no aparece donde no está disponible.
- **Filtro de posiciones GPS** - el umbral adaptativo (ver
  [Filtro de posiciones GPS](#filtro-de-posiciones-gps-anti-teletransporte-rtkntrip))
  protege muy bien el caso dominante (maquinaria lenta), pero para
  un vehículo ligero que ya circula rápido el margen relativo es
  más ancho, así que haría falta un salto proporcionalmente mayor
  para dispararlo. Los rechazos quedan auditables
  (`positions.valid = false`) para afinar
  `POSITION_FILTER_TOLERANCE_FACTOR`/`POSITION_FILTER_ABSOLUTE_CEILING_KMH`
  con datos reales, sin tocar código.
