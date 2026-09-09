# GAGA-GPS

Sistema propio de geolocalización y control de flota en tiempo real
para operación minera.

Reemplaza a Traccar Server como backend de telemetría: las tabletas
en los vehículos siguen usando la app **Traccar Client** sin
modificaciones (protocolo OsmAnd), pero reportan directamente a este
backend Node.js, que persiste la telemetría, evalúa reglas de
seguridad automáticas y distribuye todo en tiempo real a tres paneles
web.

---

## Tabla de contenido

1. [Visión general](#visión-general)
2. [Arquitectura](#arquitectura)
3. [Stack tecnológico](#stack-tecnológico)
4. [Estructura del proyecto](#estructura-del-proyecto)
5. [Autenticación y roles](#autenticación-y-roles)
6. [Multi-tenencia por proyecto](#multi-tenencia-por-proyecto)
7. [Modelo de datos](#modelo-de-datos)
8. [Funcionalidades](#funcionalidades)
   - [Geocercas](#geocercas-polígono-líneacorredor)
   - [Equipo estático](#equipo-estático)
   - [Visor de recorridos (historial)](#visor-de-recorridos-historial)
   - [Alertas de incidente en tiempo real](#alertas-de-incidente-en-tiempo-real)
   - [Historial unificado de alertas](#historial-unificado-de-alertas)
   - [Importador de mapas satelitales](#importador-de-mapas-satelitales)
   - [Turnos de operador](#turnos-de-operador)
9. [Módulos de seguridad en tiempo real](#módulos-de-seguridad-en-tiempo-real)
10. [Paneles](#paneles)
11. [Instalación y despliegue](#instalación-y-despliegue)
    - [Variables de entorno](#variables-de-entorno)
    - [Caddy: HTTPS y dominio](#caddy-https-y-dominio)
    - [Desarrollo local](#desarrollo-local)
12. [Configurar Traccar Client en las tabletas](#configurar-traccar-client-en-las-tabletas)
13. [Referencia de la API](#referencia-de-la-api)
14. [Eventos de Socket.io](#eventos-de-socketio)
15. [Seguridad del backend](#seguridad-del-backend)
16. [Datos: retención, compresión y escalabilidad](#datos-retención-compresión-y-escalabilidad)
17. [Tests](#tests)
18. [Acceso directo a PostgreSQL y Redis](#acceso-directo-a-postgresql-y-redis)
19. [Solución de problemas comunes](#solución-de-problemas-comunes)
20. [Visión a futuro](#visión-a-futuro)
21. [Limitaciones conocidas](#limitaciones-conocidas)

---

## Visión general

GAGA-GPS rastrea en tiempo real una flota de vehículos y maquinaria
dentro de una operación minera, usando tabletas Android con Traccar
Client como dispositivos GPS. El backend recibe esa telemetría
directamente, la persiste, evalúa un conjunto de reglas de seguridad
automáticas (geocercas, anticolisión, pérdida de señal, aproximación
a equipo pesado, parada preventiva colectiva) y distribuye todo en
tiempo real a tres interfaces web, detrás de un login único:

- **Operador** (`/operator`) - vista en campo, en la tableta del
  vehículo: mapa, alertas, posición/velocidad propia.
- **Supervisor** (`/supervisor`) y **Encargado** (`/manager`) - sala
  de control de solo lectura: mapa, flota, alertas, historial. El
  Supervisor se acota a su turno programado; el Encargado ve todo el
  proyecto y todos sus turnos.
- **Admin** (`/administrator`, o `/project-admin` para el rol
  acotado a un proyecto) - gestión: proyectos, dispositivos,
  geocercas, equipo estático, usuarios, turnos, historial/reportes,
  mapas satelitales, configuración global.

## Arquitectura

```
Tableta (Traccar Client, protocolo OsmAnd)
        │ GET/POST /gps?id=...&lat=...&lon=...
        ▼
backend/src/api/routes/telemetry.routes.ts
        │ Valida clave compartida, parámetros, rango lat/lon
        ▼
backend/src/services/telemetry/PositionProcessor.ts
        │ 1. Auto-registra el dispositivo si es nuevo (DeviceManager)
        │ 2. Filtra saltos físicamente implausibles (PositionFilterService)
        │ 3. Persiste en PostgreSQL/TimescaleDB (PositionRepository)
        │ 4. Actualiza el estado en memoria (FleetStateManager → Redis)
        │ 5. Evalúa módulos de seguridad (geocercas, colisión, señal, equipo)
        │ 6. Distribuye vía Socket.io (FleetSocketServer)
        ▼
UI Operador (solo app instalada) / UI Supervisor / UI Admin (navegador)
```

Todo el procesamiento ocurre de forma síncrona en el momento en que
llega la petición HTTP - no existe ningún Traccar Server, WebSocket
externo ni polling intermedio.

## Stack tecnológico

| Componente             | Tecnología                              | Uso                                                                                |
| ----------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Backend                 | Node.js 22 + Express 5 + TypeScript      | API REST, receptor de telemetría, lógica de seguridad                              |
| Frontend                | React + TypeScript + Vite                | SPA única con code-splitting por rol (React Router + `React.lazy()`)               |
| Tests                   | Vitest                                   | Caracterización de los módulos de seguridad + integración real contra Postgres     |
| Tiempo real              | Socket.io 4                              | Distribución de posiciones/alertas a las UIs                                       |
| Base de datos            | PostgreSQL 16 + TimescaleDB              | Dispositivos, geocercas, equipo, usuarios, histórico de posiciones (hypertable)    |
| Extensión espacial       | PostGIS                                  | Evaluación en tiempo real de geocercas (`ST_Contains`/`ST_DWithin` + índice GiST)  |
| Caché / estado en vivo   | Redis 7                                  | Última posición conocida de cada dispositivo (no guarda histórico)                 |
| Autenticación            | JWT (jsonwebtoken) + bcryptjs            | Login único, con revalidación de usuario activo en cada request                    |
| Mapas                    | MapLibre GL + MBTiles (better-sqlite3)   | Renderizado de mapas offline en las tabletas                                       |
| Procesamiento geoespacial | GDAL                                     | Conversión de imágenes satelitales/drone georreferenciadas a MBTiles               |
| Contenerización          | Docker + Docker Compose                  | Stack completo en un solo `docker-compose.yml`, igual para desarrollo y producción |
| Reverse proxy HTTPS      | Caddy 2.11                               | Terminación HTTPS automática y proxy inverso hacia el backend                      |
| Cliente GPS              | Traccar Client (app de terceros)         | Corre en las tabletas, protocolo OsmAnd                                            |

Monorepo con `npm workspaces` (sin Turborepo/Nx - no se justifican
para el tamaño de este equipo): un solo `package-lock.json`, un solo
`docker compose up -d --build` que construye backend + frontend en
una sola imagen.

## Estructura del proyecto

Separación por a quién le pertenece el código, no por dónde termina compilado: `backend/` es el
único servicio que consultan tanto la web como la app móvil (nunca se compila dentro de nada);
`web/` es el código exclusivo de Admin/Supervisor/Encargado; `app/` es todo lo exclusivo de la
app nativa - incluido el panel de Operador completo (`app/packages/operator-ui`), aunque su
bundle final se siga compilando junto con el de `web/` en un solo `vite build` (`web/` lo importa
por nombre, igual que hace con `android-bridge`, porque su bundle único necesita ese código para
poder renderizarlo - eso no cambia a quién le pertenece el archivo fuente). El único paquete que
queda neutral en la raíz es `shared-types`, porque backend y web lo importan cada uno por su
lado, sin que ninguno "empaquete" al otro.

```
gaga-gps-001/
├── backend/
│   ├── Dockerfile              # build multi-stage: tsc + vite build → imagen runtime
│   ├── db/
│   │   └── 001_init.sql        # schema completo, se aplica solo al crear un volumen de Postgres nuevo
│   └── src/
│       ├── app.ts              # entry point - ensambla todo, sirve la SPA + fallback de rutas
│       ├── config/              # pool de PostgreSQL, cliente Redis, env (validado con zod)
│       ├── repositories/        # acceso a datos (CRUD PostgreSQL, sin ORM)
│       ├── services/
│       │   ├── telemetry/       # PositionProcessor, PositionFilterService, DeviceManager, FleetStateManager
│       │   ├── alerts/          # módulos de seguridad (geocercas, colisión, proximidad, señal, incidentes)
│       │   ├── static_equipment/
│       │   └── maps/            # pipeline de imágenes georreferenciadas → MBTiles
│       ├── sockets/              # FleetSocketServer (Socket.io, eventos tipados desde shared-types)
│       ├── api/
│       │   ├── routes/           # un archivo por recurso
│       │   └── middleware/       # auth (JWT + Socket.io), rate limiting
│       ├── scripts/              # seed-admin.ts
│       └── utils/                # geometry.ts, geoFormats.ts (funciones puras)
│
├── web/                           # Vite + React + TS - la SPA de Admin/Supervisor/Encargado
│   ├── src/
│   │   ├── main.tsx, App.tsx     # BrowserRouter + rutas protegidas + React.lazy() por rol
│   │   └── features/
│   │       ├── auth/              # LoginScreen (login único) + ProtectedRoute
│   │       ├── admin/             # AdminApp + sections/ (Dashboard, Sistema)
│   │       └── supervisor/        # SupervisorApp - sala de control
│   └── packages/                  # exclusivos de la web - nadie más los importa directo
│       ├── client/                # fetch tipado + Socket.io tipado + sesión compartida
│       ├── map-core/              # capas de mapa satelital y render de geocercas, compartido por los 3 paneles
│       └── ui/                    # Button, AlertBanner, VehicleCard, MapModeSelector, StatCard, tokens de color
│
├── app/
│   ├── android/                   # proyecto Capacitor - empaqueta el bundle de web/ + operator-ui, sin fork
│   └── packages/
│       ├── android-bridge/        # interfaz TS hacia los plugins nativos (TraccarSender, RtkNtrip)
│       └── operator-ui/           # OperatorApp + DeviceSettingsPanel - exclusivos de la app, web/ los importa por nombre
│
├── packages/
│   └── shared-types/               # Device, Geofence, Position, FleetState, Alert*, eventos de Socket.io
│
├── config/                          # tooling que casi nunca se toca a mano
│   ├── tsconfig.base.json           # compilerOptions base que extiende cada paquete
│   ├── eslint.config.js             # reglas de lint del monorepo completo
│   └── vitest.config.mts            # proyectos unit/integration
│
├── Caddyfile                        # configuración HTTPS/proxy (un solo archivo, sin carpeta propia)
├── package.json                     # workspaces + scripts build/test/lint a nivel monorepo
├── docker-compose.yml                # stack completo - dev y producción
├── .env.example                      # única plantilla de variables
└── README.md
```

Los 4 `packages/*` se consumen como TypeScript fuente, sin build
propio - Vite/`tsc` los resuelven vía los symlinks de `npm
workspaces`.

## Autenticación y roles

Todos los roles tienen cuenta con correo y contraseña, y pasan por un
**login único** (`/`) dentro de la misma SPA. No existen logins
separados por rol.

```
/                                            (login único)
        │ POST /api/auth/login  →  { token, user: { role } }
        ▼
navigate(`/${resolveRolePath(role)}`)
        │
        ├─ role="admin"                  → /administrator
        ├─ role="project_administrator"  → /project-admin (mismo panel que admin, acotado a un proyecto)
        ├─ role="project_manager"        → /manager       (mismo panel que supervisor, solo lectura de todo el proyecto)
        ├─ role="project_supervisor"     → /supervisor
        └─ role="operator"               → /operator
```

5 roles reales. `admin`/`project_administrator` comparten literalmente el
mismo componente de panel, y `project_supervisor`/`project_manager`
comparten el otro - la ruta separada solo existe para que la URL
refleje con qué rol se entró y cada uno reciba sus permisos.

**Roles genéricos, no una lista fija** - `users.role` es texto libre
sin restricción a nivel de base de datos. Agregar un rol nuevo no
requiere migración: una opción más en el `<select>` de Admin →
Usuarios, decidir qué rutas puede usar (`requireRole('nuevo_rol')`)
y, si necesita vista propia, una carpeta en `features/` + una ruta
protegida más.

**Sesión y tokens**:
- Duración del token decidida por el backend según el rol: operador
  `OPERATOR_JWT_EXPIRES_IN` (30 días por defecto, para no forzar
  re-login constante en la tableta); el resto `JWT_EXPIRES_IN` (8h).
- Cada request protegido revalida contra PostgreSQL que el usuario
  siga activo y conserve el mismo rol - si se desactiva a alguien,
  su sesión se corta de inmediato sin esperar a que expire el token.
- Los sockets también requieren JWT válido en el *handshake* de
  conexión.
- `POST /api/fleet/stop`/`/resume` (parada preventiva colectiva)
  requieren rol `admin`, `project_administrator` o `project_supervisor`;
  `GET /api/fleet/state` y `/stop/status` son de solo lectura y
  públicos.

**Code-splitting real por rol** - cada feature de rol es un
`import()` dinámico, así Vite genera un chunk separado por rol: un
operador nunca descarga el código de Admin (tablas, herramientas de
dibujo de geocercas). El único chunk pesado compartido entre los 3
es MapLibre GL, usado por los tres para renderizar mapas.

### Turnos y vinculación de dispositivo

Separa dos identidades que no deben mezclarse:

- **Identidad del vehículo/tableta** - fija por configuración de
  kiosco (`?device=X` en la URL del panel Operador, con fallback a
  `localStorage`). Se valida contra el backend
  (`GET /api/devices/lookup/:uniqueId`) antes de continuar.
- **Identidad del operador** - resuelta por el login único. Con el
  dispositivo identificado y sin turno activo, se ofrece "Iniciar
  turno" (`operator_sessions`) - un mismo operador puede operar
  máquinas distintas en momentos distintos, y el sistema reporta
  tanto "¿quién operó este vehículo?" como "¿cuántas horas trabajó
  esta persona?" (`GET /api/operator-sessions/report`).

Mientras la pestaña siga abierta, el panel Operador envía un
heartbeat cada 5 minutos; un turno sin heartbeat por más de
`OPERATOR_SESSION_MAX_IDLE_DAYS` (7 días por defecto) se cierra
automáticamente en segundo plano.

## Multi-tenencia por proyecto

El sistema aísla varios **proyectos** (sitios de operación) entre sí
- un usuario/dispositivo de un proyecto nunca ve datos de otro.
`projects` es la tabla raíz; `users.project_id`, `devices.project_id`,
`geofences.project_id`, `static_equipment.project_id` y
`maps.project_id` enlazan cada fila a un proyecto.
`project_id = NULL` en un usuario `admin` es el único caso de
alcance global - todos los demás roles siempre tienen un proyecto.

**Roles de proyecto**:

- **`project_administrator` (Administrador de Proyecto)** - equivalente a
  un Admin, acotado a su propio proyecto. Acceso total
  (crear/editar/eliminar) a Dispositivos, Usuarios, Geocercas, Equipo
  estático, Mapas, Turnos e Historial de su proyecto. Nunca puede
  mover un dispositivo/usuario a OTRO proyecto (exclusivo de
  `admin`), ni asignar el rol `admin` a un usuario.
- **`project_manager` (Encargado de Proyecto)** - mismo panel que Supervisor, pero
  sin ninguna capacidad de edición y sin acotarse a un turno: ve la
  flota completa del proyecto en tiempo real, todos los turnos
  programados y el historial completo de alertas.
- **`project_supervisor` (Supervisor de Proyecto)** - panel propio
  (sala de control), con el mapa y la lista de vehículos acotados a
  su **turno programado asignado**, no a todo el proyecto. Solo
  lectura - sin acceso a Dispositivos, Usuarios, Geocercas, Equipo
  estático, Mapas, Historial de recorridos/CSV ni Sistema
  (conserva parada preventiva colectiva y resolver incidentes, por
  ser acciones operativas de seguridad en vivo, no edición de
  configuración). El historial de alertas (no de posiciones) se
  acota a su propio turno, salvo una alerta todavía activa de un
  turno anterior.

**Admin → Dashboard** es un mapa grande con toda la operación en
tiempo real - "Global" por defecto (todos los proyectos a la vez), o
un proyecto específico elegido en el selector. Turnos es la única
sección que exige un proyecto real (no aplica en "Global").

**Aislamiento aplicado en 3 capas**:
- **JWT** - `projectId` en el token, revalidado en cada request.
- **Socket.IO** - salas nativas (`project:<id>`, o la sala de admin
  que recibe todo) - `broadcastToProject()` emite solo a esas salas.
- **REST** - cada ruta de listado filtra por `req.user.projectId`
  cuando no es `null`; Admin siempre ve todo sin filtrar.

**Eliminar un proyecto** (`DELETE /api/projects/:id`) borra de
verdad sus turnos, geocercas, equipo estático, incidentes e
historial de alertas (incluidos los `.mbtiles` de sus mapas). Nunca
elimina usuarios ni dispositivos - se desvinculan
(`project_id = NULL`); los usuarios además se desactivan. Toda la
operación corre en una sola transacción.

**Historial de proyecto por dispositivo/usuario** - mover un
dispositivo u operador de un proyecto a otro (solo `admin`) queda
registrado con fecha exacta en `device_project_history`/
`user_project_history`, para poder saber a futuro en qué proyecto
(y con qué turno) estuvo un dispositivo/operador en una fecha
pasada, incluso después de reasignarlo. `positions.project_id` y
`operator_sessions.project_id` guardan el proyecto vigente al
momento de cada registro por el mismo motivo.

## Modelo de datos

Definido en `backend/db/001_init.sql`, se aplica automáticamente
la primera vez que se crea el volumen de PostgreSQL.

| Tabla                     | Propósito                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `projects`                | Sitios de operación aislados entre sí                                                               |
| `devices`                 | Dispositivos/tabletas - `unique_id` es el identificador configurado en Traccar Client                |
| `positions`                | Hypertable de TimescaleDB - una fila por posición GPS, particionada por `fix_time`                   |
| `geofences`                | Geocercas - polígono o polilínea/corredor (círculo solo heredado); paleta fija de 9 tipos semánticos |
| `geofence_events`          | Auditoría de entradas/salidas de geocercas                                                          |
| `static_equipment`         | Equipo estático con radio de giro/seguridad - `linked_device_id` vincula opcionalmente una tableta   |
| `users`                    | Cuentas de todos los roles                                                                          |
| `shifts`                   | Turnos programados recurrentes por proyecto (horario diario)                                        |
| `operator_sessions`        | Turno real operador+vehículo (identidad, no horario)                                                |
| `incident_reports`         | Incidentes reportados por operadores en tiempo real                                                 |
| `alert_events`             | Historial unificado de las 6 familias de alerta, para "Activas"/"Historial" del panel de Supervisor |
| `maps`                     | Mapas satelitales/drone importados (metadata del pipeline, no el archivo en sí)                     |
| `device_sensor_snapshots`  | Sensores del navegador del Operador (batería, red, memoria) - hypertable separada de `positions`     |
| `device_project_history`   | Historial temporal de a qué proyecto perteneció cada dispositivo (`valid_from`/`valid_to`)           |
| `user_project_history`     | Historial temporal de a qué proyecto perteneció cada usuario (`valid_from`/`valid_to`)               |
| `system_settings`          | Configuración editable desde el panel de Admin en tiempo real (ej. clave compartida de telemetría)   |

## Funcionalidades

### Geocercas (polígono, línea/corredor)

Dos formas creables (máxima compatibilidad con lo que exporta Google
Earth vía KML), evaluadas en tiempo real contra la posición de cada
vehículo:

- **Polígono** - área de forma arbitraria, dibujada en el mapa del
  panel Admin. Puede ser **con relleno** (zona completa - la alerta
  se dispara mientras el vehículo está dentro) o **sin relleno**
  (la alerta se dispara solo al acercarse a la línea del borde, sin
  importar si está adentro o afuera).
- **Línea/corredor** - trazo con un ancho real definido, con dos
  comportamientos posibles: **debe quedarse dentro** del ancho (ej.
  Ruta autorizada - alerta si el vehículo se aleja) o **no debe
  tocarla** (alerta si el vehículo se acerca).

En los cuatro casos, **la acción/severidad de la alerta la decide
siempre el tipo de geocerca** (tabla de abajo) - la forma y el modo
solo deciden en qué momento se dispara esa alerta, nunca escalan la
severidad por distancia.

(El círculo - centro + radio - sigue existiendo a nivel de datos para
geocercas creadas antes de este cambio, pero ya no se ofrece como
opción al crear una nueva.)

**Paleta fija de 9 tipos semánticos**, cada uno con su color y
comportamiento de alerta propios (el color se deriva siempre del
tipo, no es libre):

| Tipo | Color | Alerta |
|---|---|---|
| `forbidden` - Zona prohibida | negro | crítica, mensaje propio |
| `danger` - Peligro | rojo | crítica |
| `warning` - Advertencia | amarillo | advertencia |
| `authorized_route` - Ruta autorizada | naranja | advertencia, mensaje propio |
| `allowed` - Zona permitida | verde | ninguna, solo visual |
| `parking` - Estacionamiento | azul | informativa, sin sirena |
| `discharge` - Descarga | café | ninguna, solo visual |
| `carga` - Carga | cyan | ninguna, solo visual |
| `maintenance` - Mantenimiento | morado | advertencia, mensaje propio |

Al importar un KML/GeoJSON de Google Earth, el tipo se detecta por el color más
cercano (distancia RGB) al de esta tabla - no hace falta que el color exportado
coincida exactamente, cualquier tono de la rueda de color de Google Earth cae en
el tipo más parecido.

Cada entrada/salida queda registrada en `geofence_events` para
auditoría. Se crean/editan desde un panel flotante sobre el mapa
grande de Admin, con vista previa en vivo y edición de vértices tras
guardar. Exportables en GeoJSON o KML (con color real vía
`<Style>`); importables desde cualquiera de esos dos formatos - al
importar un KML de Google Earth, el tipo se detecta por color exacto
contra la paleta de arriba (si el color no coincide con ninguno, cae
en Advertencia por default).

### Equipo estático

Maquinaria fija (palas, excavadoras) con radio de giro y radio de
seguridad - guía de aproximación en tiempo real para cualquier
vehículo que se acerque. Puede vincularse opcionalmente a una
tableta (una excavadora con operador propio): mientras esa tableta
tenga un turno activo, el equipo pasa automáticamente a "en
operación"; sin turno activo, queda "inactivo" - una sola fuente de
verdad, sin control manual encima. El operador de esa tableta se ve
a sí mismo en el mapa como el equipo (dos anillos concéntricos), no
como un vehículo en movimiento.

### Visor de recorridos (historial)

Modo dentro de Admin → Dashboard: el mismo mapa deja de mostrar
vehículos en vivo y dibuja en cambio el recorrido histórico del
dispositivo elegido, coloreado por tramo según si estaba dentro
(azul) o fuera (rojo) de una geocerca. Panel de filtro (dispositivo +
rango de fechas), barra de reproducción y panel de detalle por punto
(fecha, posición, velocidad, rumbo, altitud, precisión, batería).

### Alertas de incidente en tiempo real

Un operador reporta un peligro (objeto en el camino, accidente,
tráfico) desde su posición actual. Se marca un punto con radio en el
mapa de los demás vehículos del mismo proyecto, alerta a quien se
acerque, y queda visible para Supervisor/Encargado hasta que alguien
lo resuelve.

### Historial unificado de alertas

Las 6 familias de alerta (geocerca, señal perdida, colisión,
proximidad, parada preventiva, incidente) quedan registradas en
`alert_events` - alimenta tanto "Activas" (sobrevive a un reload de
la página) como "Historial con filtros" en el panel de Supervisor.

### Importador de mapas satelitales

Admin → Dashboard → overlay Mapas: importa imágenes satelitales o de
dron georreferenciadas (par `.tif`+`.tfw` o `.jpg`+`.jpw`) y las
convierte al formato offline (`.mbtiles`) que ven Operador y
Supervisor. Procesamiento en segundo plano con GDAL, sin bloquear la
recepción de telemetría. Varios mapas pueden estar activos a la vez,
apilados como capas independientes. Selector de 3 modos en Operador/
Supervisor: Calles (OSM), Satelital (solo capas importadas) o Mixto.

### Turnos de operador

Ver [Turnos y vinculación de dispositivo](#turnos-y-vinculación-de-dispositivo).
El Administrador de Proyecto crea los turnos programados y asigna un
Supervisor a cada uno; al iniciar un turno de operador, el sistema
resuelve solo a qué turno programado pertenece según la hora actual.

## Módulos de seguridad en tiempo real

| Módulo                    | Función                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `GeofenceAlertService`     | Alerta al entrar en zona amarilla/roja/estacionamiento - evaluación vía PostGIS            |
| `SignalLostService`        | Nivel 1 (10s sin señal) y Nivel 2 (20s, activa parada preventiva automática)                |
| `CollisionRiskService`     | Anticolisión - distancia + trayectoria proyectada entre vehículos                          |
| `VehicleProximityService`  | Radar de distancia entre vehículos fuera de un corredor/ruta autorizada                    |
| `PreventiveStopService`    | Parada preventiva colectiva - solo un rol de supervisión puede desactivarla                |
| `StaticEquipmentManager`   | Guía de aproximación a equipo estático con radio de giro                                   |

**Geocercas evalúa vía PostGIS** (`ST_Contains`/`ST_DWithin` + índice
`GiST` sobre `geofences.geog`) - un solo query indexado, filtrado
primero por proyecto, en vez de recorrer un arreglo en memoria. Los
demás módulos se quedan en JavaScript puro, en memoria: comparan
vehículos/equipo entre sí contra listas chicas y volátiles (la flota
actual), donde un índice espacial no aporta nada.

**Filtro de posiciones GPS (anti-teletransporte)** - compara cada
posición nueva contra la última posición aceptada del mismo
dispositivo (distancia/tiempo = velocidad implícita), con un umbral
adaptativo según la velocidad reciente propia del dispositivo, no un
límite fijo por "tipo de vehículo". Los puntos rechazados se guardan
marcados `valid = false` (auditable) pero nunca aparecen en mapa,
historial ni reportes. Variables de ajuste: `POSITION_FILTER_*` (ver
[Variables de entorno](#variables-de-entorno)).

**Estimación de velocidad** - combina la velocidad Doppler del GPS
con la velocidad derivada del desplazamiento real, descarta el valor
reportado si diverge demasiado, y aplica un suavizado (EMA). Por
debajo de `minSpeedKmh` (1 km/h) reporta 0 en vez del ruido normal de
un vehículo detenido.

**Radar de proximidad fuera de ruta** - a diferencia de
`CollisionRiskService` (exige trayectorias convergentes), evalúa
distancia pura entre vehículos que no estén dentro de un corredor
autorizado - pensado para patios y zonas de maniobra sin ruta
definida.

## Paneles

**Admin/Administrador de Proyecto** (`/administrator`,
`/project-admin`) - Dashboard (mapa grande con toda la operación,
overlays de Proyectos/Turnos/Dispositivos/Usuarios/Geocercas/Equipo/
Mapas, cada uno filtrado por el proyecto elegido en el selector -
disponible también con "Global" seleccionado), Sistema (configuración
global - solo Admin - y health check en vivo). Historial de
recorridos vive como modo interactivo dentro de Dashboard (filtro de
dispositivo/rango + reproducción sobre el mapa), con exportación a
CSV como una opción más dentro del mismo filtro.

**Supervisor/Encargado** (`/supervisor`, `/manager`) - mismo panel,
sala de control con mapa, lista de vehículos, alertas activas/
historial. Supervisor ve solo su turno programado y conserva el
botón de parada preventiva colectiva; Encargado ve todo el proyecto
y todos los turnos, sin ninguna acción de edición.

**Operador** (`/operator`) - vista en campo, **exclusiva de la app instalada** - su código fuente vive en `app/packages/operator-ui`, no en `web/`, y un login con rol Operador desde un navegador normal se rechaza explícitamente, incluso con credenciales válidas. Principio de diseño:
*local complementa, nunca reemplaza* - la posición/velocidad propia
usa la Geolocation API del navegador como fuente primaria (respuesta
inmediata, funciona sin conexión), mientras que todo lo que el
navegador no puede ver por sí solo (el resto de la flota, alertas de
colisión/proximidad, geocercas, mapas, turnos) sigue viniendo
exclusivamente del servidor - las alertas de seguridad nunca son
decisión del cliente. Incluye indicador de GPS local independiente
del estado de conexión al servidor, batería vía Battery Status API
(donde el navegador la expone), y el mismo filtro anti-teletransporte
que corre en el backend, aplicado también en el navegador.

## Instalación y despliegue

Un único flujo, con un solo comando, para desarrollo local o
producción - no hay archivos ni pasos distintos entre entornos. Todo
el sistema corre en contenedores Docker orquestados por
[docker-compose.yml](docker-compose.yml).

**Requisitos**: Docker Desktop (o Docker Engine + Compose plugin en
Linux).

```bash
git clone https://github.com/SrRusian/gaga-gps-001.git
cd gaga-gps-001

cp .env.example .env
# Editar .env - como mínimo: DB_PASSWORD, REDIS_PASSWORD, JWT_SECRET,
# TELEMETRY_SHARED_SECRET

docker compose up -d --build
```

Si la tabla de usuarios está vacía (primera vez que se crea el
volumen), el backend crea automáticamente un admin:
**`admin@gaga.com` / `admin`** (o los valores de
`DEFAULT_ADMIN_EMAIL`/`DEFAULT_ADMIN_PASSWORD` en `.env`) - cambiar
esa contraseña de inmediato desde el panel. Este mecanismo solo se
activa una vez, con la tabla completamente vacía.

Para crear el primer admin con credenciales propias en vez de usar
las de por defecto, o para resetear una contraseña sin pasar por el
panel:

```bash
docker compose exec gaga-backend \
  npm run seed:admin -- admin@tuempresa.com TuPasswordSegura "Nombre Admin"
```

Para actualizar tras un cambio de código:

```bash
git pull
docker compose up -d --build
```

**Persistencia** - PostgreSQL, Redis y los mapas satelitales viven en
volúmenes con nombre (`postgres_data`, `redis_data`, `maps_data`,
`caddy_data`, `caddy_config`), fijados explícitamente en
`docker-compose.yml` (`name: gaga-gps-001`) - reconstruir la imagen
del backend nunca borra datos. `backend/db/001_init.sql` solo se
aplica una vez, al crear el volumen de Postgres.

**Borrado total intencional** (para empezar de cero de verdad):

```bash
docker compose down -v
```

El `-v` borra también los volúmenes con nombre, incluidos los mapas
satelitales importados - no es un comando para usar a la ligera en
producción.

### Variables de entorno

Un único archivo - [.env.example](.env.example) en la raíz - copiar a
`.env`. Es el mismo archivo para desarrollo, para correr el backend
sin Docker y para producción; lo único que cambia entre entornos es
`NODE_ENV`.

| Variable                                  | Obligatoria                   | Descripción                                                                                   |
| ------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `DB_PASSWORD`                             | Sí                             | Contraseña de PostgreSQL                                                                       |
| `REDIS_PASSWORD`                          | Sí                             | Contraseña de Redis                                                                            |
| `NODE_ENV`                                | Sí                             | `development` o `production` - activa validaciones estrictas de seguridad en `production`      |
| `JWT_SECRET`                              | Obligatoria en producción      | Firma de tokens - el backend falla al arrancar si falta en producción                          |
| `TELEMETRY_SHARED_SECRET`                 | Obligatoria en producción      | Clave compartida para `/gps` - mitiga inyección de posiciones falsas                            |
| `JWT_EXPIRES_IN`                          | No (default `8h`)              | Vigencia del token de sesión del panel                                                         |
| `OPERATOR_JWT_EXPIRES_IN`                 | No (default `30d`)             | Vigencia del token de la UI de operador                                                        |
| `OPERATOR_SESSION_MAX_IDLE_DAYS`          | No (default `7`)               | Días sin heartbeat tras los cuales se cierra automáticamente un turno abandonado                |
| `MAPS_DIR`                                | No (default `maps`)            | Carpeta con los `.mbtiles` servidos en `/tiles`                                                |
| `DB_POOL_MAX`                             | No (default `20`)              | Tamaño del pool de conexiones a Postgres - subir en flotas grandes (300+ dispositivos)          |
| `POSITION_FILTER_TOLERANCE_FACTOR`        | No (default `1.8`)             | Margen sobre la velocidad reciente antes de considerar un salto sospechoso                      |
| `POSITION_FILTER_MIN_FLOOR_KMH`           | No (default `25`)              | Piso mínimo (km/h) del umbral adaptativo                                                       |
| `POSITION_FILTER_ABSOLUTE_CEILING_KMH`    | No (default `120`)             | Techo de seguridad (km/h) del umbral adaptativo                                                |
| `POSITION_FILTER_JITTER_RADIUS_M`         | No (default `5`)               | Radio (metros) de ruido GPS normal con el vehículo detenido                                     |
| `POSITION_FILTER_HISTORY_WINDOW`          | No (default `8`)               | Cuántas velocidades recientes se recuerdan por dispositivo                                      |
| `POSITION_FILTER_MAX_CONSECUTIVE_REJECTS` | No (default `3`)               | Rechazos consecutivos antes de resincronizar                                                    |
| `MAX_MAP_UPLOAD_MB`                       | No (default `500`)             | Tamaño máximo por archivo al importar un mapa satelital/drone                                  |
| `DEFAULT_ADMIN_EMAIL`                     | No (default `admin@gaga.com`)  | Email del admin creado automáticamente si la tabla de usuarios está vacía                       |
| `DEFAULT_ADMIN_PASSWORD`                  | No (default `admin`)           | Contraseña de ese admin - cambiar tras el primer login                                          |

`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `REDIS_HOST` y
`REDIS_PORT` no están en `.env` - son fijos dentro de la red Docker.

### Caddy: HTTPS y dominio

El servicio `caddy` publica `80`/`443` y actúa como reverse proxy
HTTPS. En producción, crear registros DNS A/AAAA para el dominio
principal y su subdominio de aplicación, apuntando a la IP pública
del servidor - con ambos resolviendo, Caddy obtiene y renueva
automáticamente los certificados TLS. `reverse_proxy` soporta las
conexiones WebSocket de Socket.io, así que las UIs y los eventos en
tiempo real funcionan a través del mismo dominio HTTPS.

```bash
# Validar la configuración
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile

# Recargarla sin detener el proxy
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile

# Ver solicitudes, certificados y errores
docker compose logs -f caddy
```

### Desarrollo local

El backend **siempre** corre dentro de Docker, nunca nativo en la
máquina del desarrollador (evita depender de GDAL u otras
herramientas de sistema instaladas a mano):

```bash
npm run dev
```

Un solo comando: instala dependencias si faltan, levanta
`postgres`+`redis`+`gaga-backend` en Docker (imagen normal, la misma
que producción - GDAL incluido) y el frontend con Vite en el host
(puerto 5173, con hot module reload). Usar `http://localhost:5173`
mientras se edita - proxy ya configurado hacia `:3001` para `/api`,
`/gps`, `/tiles`, `/health` y el socket.

**El backend no tiene hot-reload** - un cambio en `backend/src`
requiere volver a correr `npm run dev` (o `npm run dev:backend`) para
que Docker reconstruya la imagen y reinicie el contenedor.

También pueden correrse por separado:

```bash
npm run dev:backend    # solo postgres+redis+backend, en Docker
npm run dev:web-app    # solo frontend, espera a que el backend responda /health
```

No espera a que haya un backend real respondiendo - las llamadas a la
API van a fallar. Sirve únicamente para iterar rápido sobre lo
visual, no para probar funcionalidad real con datos.

## Configurar Traccar Client en las tabletas

En la app Traccar Client (Android/iOS):

- **Device Identifier**: cualquier texto único para ese vehículo
  (ej. `CAMION-01`) - se convierte en `unique_id` en `devices`.
- **Server URL**: URL completa hasta `/gps`, usando la IP LAN o el
  dominio real del backend (nunca `localhost`):
  ```
  http://<ip-o-dominio-del-backend>:3001/gps?key=TU_CLAVE_SECRETA
  ```
  (el parámetro `key` solo si `TELEMETRY_SHARED_SECRET` está
  configurado).
- **Frequency / Distance**: 15-20 segundos como referencia general -
  el sistema también soporta reportes más frecuentes (hasta
  1/segundo) gracias a la política de compresión de datos.

El backend acepta `GET` o `POST`, con los parámetros en la URL o en
el cuerpo de la petición - distintas versiones de Traccar Client usan
una u otra forma.

## Referencia de la API

Todas las rutas bajo `/api/*` (excepto `/api/auth/login` y
`/api/fleet/*`) requieren header `Authorization: Bearer <token>`.

| Método   | Ruta                                      | Auth                        | Descripción                                                                    |
| -------- | ------------------------------------------ | ---------------------------- | --------------------------------------------------------------------------------- |
| GET/POST | `/gps`                                    | Clave compartida opcional    | Receptor de telemetría (protocolo OsmAnd)                                       |
| GET      | `/tiles/maps/:mapId/:z/:x/:y.png`         | No                            | Tiles offline (MBTiles) de un mapa específico                                   |
| GET      | `/tiles/active-maps.json`                 | JWT opcional                 | Lista de mapas activos+listos - sin token, todos; con token, filtrado por proyecto |
| GET      | `/api/maps`                               | JWT (cualquier rol de proyecto) | Listar mapas importados con su estado                                        |
| POST     | `/api/maps`                               | JWT (`admin`/`project_administrator`) | Importar mapa - multipart `name`, `image`, `worldFile`, `sourceCrs`          |
| PATCH    | `/api/maps/:id`                           | JWT (`admin`/`project_administrator`) | Renombrar un mapa                                                            |
| POST     | `/api/maps/:id/activate`                  | JWT (`admin`/`project_administrator`) | Activa este mapa como capa visible                                          |
| POST     | `/api/maps/:id/deactivate`                | JWT (`admin`/`project_administrator`) | Desactiva este mapa                                                         |
| DELETE   | `/api/maps/:id`                           | JWT (`admin`/`project_administrator`) | Eliminar un mapa (rechaza si está activo)                                   |
| POST     | `/api/auth/login`                         | No                            | Login único - devuelve JWT + rol                                                |
| POST     | `/api/auth/logout`                        | No                            | Logout (invalidación es responsabilidad del cliente)                           |
| GET      | `/api/devices/lookup/:uniqueId`           | No                            | Verifica si un dispositivo existe y si tiene turno activo                       |
| GET      | `/api/devices`                            | JWT                           | Listar dispositivos                                                            |
| GET      | `/api/devices/:id`                        | JWT                           | Detalle de un dispositivo                                                      |
| POST     | `/api/devices`                            | JWT (`admin`/`project_administrator`) | Crear dispositivo (no-admin siempre dentro de su propio proyecto)            |
| PATCH    | `/api/devices/:id`                        | JWT (`admin`/`project_administrator`) | Editar dispositivo (mover a OTRO proyecto es exclusivo de `admin`)           |
| DELETE   | `/api/devices/:id?force=true`             | JWT (`admin`/`project_administrator`) | Eliminar dispositivo (`force=true` purga también su historial)                  |
| GET      | `/api/geofences`                          | JWT (cualquier rol de proyecto) | Listar geocercas activas                                                       |
| POST     | `/api/geofences`                          | JWT (`admin`/`project_administrator`) | Crear geocerca - `shapeType`: `circle`\|`polygon`\|`polyline`                    |
| PATCH    | `/api/geofences/:id`                      | JWT (`admin`/`project_administrator`) | Editar geocerca                                                                |
| DELETE   | `/api/geofences/:id`                      | JWT (`admin`/`project_administrator`) | Eliminar geocerca                                                              |
| GET      | `/api/geofences/export.geojson`           | JWT (header o `?token=`)      | Exportar geocercas activas en GeoJSON                                          |
| GET      | `/api/geofences/export.kml`               | JWT (header o `?token=`)      | Exportar geocercas activas en KML                                              |
| POST     | `/api/geofences/import`                   | JWT (`admin`/`project_administrator`) | Importar geocercas - body `{ format: 'geojson'\|'kml', data }`                   |
| GET      | `/api/equipment`                          | JWT (cualquier rol de proyecto) | Listar equipo estático                                                         |
| POST     | `/api/equipment`                          | JWT (`admin`/`project_administrator`) | Crear equipo estático                                                          |
| PATCH    | `/api/equipment/:id`                      | JWT (`admin`/`project_administrator`) | Editar nombre/tipo/posición/radios/dispositivo vinculado                        |
| PATCH    | `/api/equipment/:id/status`               | JWT (`admin`/`project_administrator`) | Cambiar estado manualmente (ignorado si el equipo tiene tableta vinculada)       |
| DELETE   | `/api/equipment/:id`                      | JWT (`admin`/`project_administrator`) | Eliminar equipo                                                                |
| GET      | `/api/reports/history`                    | JWT                           | Historial de posiciones por dispositivo y rango de fechas                       |
| GET      | `/api/reports/history-with-zones`         | JWT                           | Igual, anotando en qué geocerca estaba cada posición                            |
| GET      | `/api/reports/history/csv`                | JWT                           | Exportar historial a CSV                                                        |
| GET      | `/api/users`                              | JWT (`admin`/`project_administrator`) | Listar usuarios                                                                 |
| POST     | `/api/users`                              | JWT (`admin`/`project_administrator`) | Crear usuario (no-admin siempre dentro de su propio proyecto, nunca rol `admin`) |
| PATCH    | `/api/users/:id`                          | JWT (`admin`/`project_administrator`) | Editar usuario (mover a OTRO proyecto y asignar rol `admin` son exclusivos de `admin`) |
| POST     | `/api/users/:id/password`                 | JWT (`admin`/`project_administrator`) | Cambiar contraseña                                                              |
| DELETE   | `/api/users/:id`                          | JWT (`admin`/`project_administrator`) | Eliminar usuario                                                                |
| GET      | `/api/operator-sessions/active?deviceId=` | No                            | Turno activo (si lo hay) de un dispositivo                                      |
| POST     | `/api/operator-sessions/start`            | JWT                           | Inicia turno del usuario autenticado en un dispositivo                          |
| POST     | `/api/operator-sessions/:id/end`          | JWT                           | Cierra el turno explícitamente                                                  |
| POST     | `/api/operator-sessions/:id/heartbeat`    | JWT                           | Marca actividad reciente                                                        |
| GET      | `/api/operator-sessions/report`           | JWT (`admin`/supervisión)     | Reporte de turnos por operador y/o dispositivo, con duración                     |
| GET      | `/api/fleet/state`                        | No                            | Estado actual de toda la flota                                                  |
| POST     | `/api/fleet/stop`                         | JWT (rol de supervisión)      | Activar parada preventiva colectiva                                            |
| POST     | `/api/fleet/resume`                       | JWT (rol de supervisión)      | Desactivar parada preventiva                                                    |
| GET      | `/api/fleet/stop/status`                  | No                            | Estado actual de la parada preventiva                                          |
| GET      | `/api/settings`                           | JWT (`admin`)                 | Configuración global editable (ej. `telemetrySharedSecret`)                    |
| PATCH    | `/api/settings`                           | JWT (`admin`)                 | Actualiza un valor - aplica en caliente, sin reiniciar el proceso                |
| GET      | `/health`                                 | No                            | Estado de PostgreSQL/Redis y de la parada preventiva                            |

## Eventos de Socket.io

| Evento                                                                                                                                        | Origen                    | Descripción                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------- |
| `fleet:update`                                                                                                                                  | PositionProcessor          | Nueva posición de uno o más vehículos                                            |
| `geofences:update`                                                                                                                              | geofences.routes            | Lista de geocercas activas actualizada                                          |
| `equipment:update`                                                                                                                              | equipment.routes            | Lista de equipo estático actualizada                                            |
| `alert:critical` / `alert:warning` / `alert:info` / `alert:clear`                                                                              | GeofenceAlertService        | Alertas de geocerca al dispositivo afectado (`info` = estacionamiento, sin sirena) |
| `supervisor:alert`                                                                                                                              | GeofenceAlertService        | Notificación de geocerca al panel de supervisor                                 |
| `signal:lost:level1` / `signal:lost:level2` / `signal:recovered`                                                                               | SignalLostService           | Pérdida/recuperación de señal de un vehículo                                    |
| `supervisor:signal_lost`                                                                                                                        | SignalLostService           | Notificación al supervisor                                                      |
| `collision:proximity` / `collision:critical` / `collision:clear`                                                                               | CollisionRiskService        | Riesgo de colisión entre vehículos                                              |
| `supervisor:collision`                                                                                                                          | CollisionRiskService        | Notificación al supervisor                                                      |
| `proximity:distance_update` / `proximity:warning` / `proximity:critical` / `proximity:clear`                                                  | VehicleProximityService     | Distancia en vivo y alertas de proximidad fuera de ruta                          |
| `supervisor:proximity`                                                                                                                          | VehicleProximityService     | Notificación al supervisor                                                      |
| `fleet:preventive_stop` / `fleet:preventive_stop_clear`                                                                                        | PreventiveStopService       | Activación/cancelación de parada preventiva colectiva                            |
| `supervisor:preventive_stop`                                                                                                                    | PreventiveStopService       | Notificación al supervisor                                                      |
| `equipment:approach_outer` / `equipment:approach_inner` / `equipment:minimum_limit` / `equipment:distance_update` / `equipment:approach_clear` | StaticEquipmentManager      | Guía de aproximación a equipo estático                                          |
| `equipment:status_update`                                                                                                                       | StaticEquipmentManager      | Cambio de estado de un equipo                                                   |
| `equipment:vehicle_approaching`                                                                                                                 | StaticEquipmentManager      | Notificación al operador del equipo estático                                    |
| `incident:reported` / `incident:resolved` / `incident:nearby`                                                                                   | IncidentAlertService        | Reporte/resolución de incidente, aviso a quien se acerca                        |
| `supervisor:incident`                                                                                                                            | IncidentAlertService        | Notificación al supervisor                                                      |
| `alerts:snapshot`                                                                                                                                | FleetSocketServer            | Hidratación de alertas activas al conectar                                      |
| `maps:active_update`                                                                                                                             | maps-admin.routes            | Conjunto de mapas satelitales activos cambió                                    |

## Seguridad del backend

- **JWT con revalidación activa** - cada request protegido consulta
  PostgreSQL para confirmar que el usuario sigue activo y conserva
  el mismo rol.
- **Clave compartida en `/gps`** (`TELEMETRY_SHARED_SECRET`) - mitiga
  que un tercero inyecte posiciones falsas. Obligatoria en producción.
- **Rate limiting por dispositivo** (no solo por IP) - varias
  tabletas detrás del mismo router/NAT no comparten cupo entre sí.
- **Validación de rango de coordenadas** - se rechazan posiciones
  fuera de `-90..90`/`-180..180`.
- **CSV sin inyección de fórmulas** - los valores exportados se
  escapan para evitar ataques de inyección en Excel/Sheets.
- **Manejo explícito de borrado con historial** - eliminar un
  dispositivo con posiciones registradas responde `409` por defecto,
  requiere `?force=true` explícito para purgar también su historial.

## Datos: retención, compresión y escalabilidad

La hypertable `positions` (TimescaleDB) tiene configurada una
política automática (`backend/db/001_init.sql`):

- **Compresión** - chunks de más de 7 días se comprimen
  automáticamente en segundo plano (10-20x menos espacio en disco),
  sin afectar consultas de historial/reportes recientes.
- **Retención** - chunks de más de 1 año se eliminan automáticamente.

Redis no requiere política de retención - solo guarda la última
posición conocida de cada dispositivo, así que su tamaño depende del
número de vehículos, no del tiempo ni de la frecuencia de reporte.

Ajustar los intervalos directamente en PostgreSQL:

```sql
SELECT remove_retention_policy('positions');
SELECT add_retention_policy('positions', INTERVAL '2 years');
```

Estimados de referencia (peor caso, reporte cada 1s; en la práctica
la mayoría de operaciones reporta cada 10-30s):

| Flota          | Espacio/año (comprimido) |
| --------------- | -------------------------- |
| 1 vehículo      | ~0.5 GB                    |
| 10 vehículos    | ~4-6 GB                     |
| 50 vehículos    | ~20-30 GB                   |
| 300 vehículos   | ~120-180 GB                 |

**Preparado para flotas grandes** (referencia: 300 dispositivos):
los índices existentes de `positions`/`geofence_events`/
`alert_events`/`device_sensor_snapshots`/`operator_sessions` ya
cubren los patrones de consulta reales del código (filtro por
`device_id`/`project_id`/`shift_id` + rango de tiempo o estado
activo). `DB_POOL_MAX` (default 20) puede subirse vía `.env` en el
servidor real para absorber ráfagas de conexión a mayor escala.

## Tests

Tres niveles, cada uno como su propio "proyecto" Vitest dentro del mismo `config/vitest.config.mts`
(`test.projects`) - ver también [`tests/README.md`](tests/README.md) para dónde poner un test nuevo.

**Unitarios** (`tests/unit/`, replicando la ruta del código que prueban - ej.
`tests/unit/backend/src/services/alerts/X.test.ts` prueba `backend/src/services/alerts/X.ts`) -
tests de **caracterización**: existen para congelar el comportamiento exacto de la lógica de
seguridad antes de tocarla, no para perseguir un porcentaje de cobertura. 100% en memoria con
fakes, sin tocar una base de datos real.

```bash
npm test              # una vez - rápido, sin dependencias externas
npm run test:watch    # modo watch
npm run lint          # ESLint sobre todo el monorepo
```

**Integración** (`tests/integration/`, Postgres+PostGIS real) - para lo que un fake en memoria no
puede cubrir: consultas SQL/PostGIS reales. Conecta a la misma instancia de Docker Compose que ya
usa el desarrollo local.

**End-to-end** (`tests/e2e/`) - contra el backend completo corriendo de verdad (HTTP real), para
flujos que de verdad necesitan el proceso completo (ej. GDAL procesando un archivo real al
importar un mapa satelital).

```bash
npm run test:integration  # solo integración (levanta Postgres solo)
npm run test:e2e          # solo e2e (levanta el stack completo solo)
npm run test:all          # las tres suites en orden - correr antes de cada push
```

Ninguno de los tres tipos de test llega a la imagen de Docker de producción - el Dockerfile solo
corre `npm run build`, nunca un script de test (los e2e conectan a un backend ya corriendo, no se
ejecutan dentro de él).

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

También puede usarse un cliente gráfico (DBeaver, pgAdmin) con host
`localhost`, puerto `5432`, base `gaga_gps`.

**Redis** (contenedor `gaga-redis`, puerto `6379`) - solo estado en
tiempo real, sin histórico:

```bash
docker exec -it gaga-redis redis-cli -a <REDIS_PASSWORD>
```

```
HGETALL gaga:fleet:state     # estado actual de toda la flota
```

## Solución de problemas comunes

| Síntoma                                                                       | Causa probable                                                                   | Solución                                                                                                       |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `NOAUTH Authentication required` (Redis)                                     | Falta `REDIS_PASSWORD` en `.env`                                                   | Debe coincidir con lo que arrancó el contenedor - `docker compose up -d --build` tras editar `.env`             |
| `Cannot GET /`, `/administrator`, `/operator`, `/supervisor`                | El build del frontend no llegó a la imagen del backend                             | Verificar que `web/dist` exista tras `npm run build`                                                    |
| Entrar a una ruta protegida manda de vuelta al login en loop                  | No hay sesión válida, o el rol no coincide con esa ruta                            | Iniciar sesión con un usuario del rol correcto; si persiste, revisar errores de red a `/api/auth/login`         |
| `401`/`403` en `/api/fleet/stop` o `/resume` con sesión iniciada             | El usuario no tiene un rol autorizado, o el token venció                          | Confirmar el rol en Admin → Usuarios; si es correcto, volver a iniciar sesión                                    |
| El socket no conecta / sin actualizaciones en vivo                           | Conexión sin JWT válido en el handshake                                            | Confirmar que hay sesión válida antes de que la app llame a `createSocket()`                                     |
| `404` en Traccar Client al mandar posición                                  | La tableta usa `POST` en vez de `GET`, u otra combinación                          | Ambos métodos están soportados - verificar que el backend esté actualizado                                       |
| `400` "Faltan parámetros requeridos" pese a que la tableta manda datos      | Traccar Client envía los parámetros en el body, no en la URL                       | Ambas formas están soportadas - confirmar `express.urlencoded()` en `app.ts`                                      |
| `DELETE /api/devices/:id` responde 409                                       | El dispositivo tiene historial de posiciones                                       | Usar `?force=true` para purgar también el historial                                                              |
| Vehículo aparece con nombre igual a su ID técnico                            | El dispositivo se auto-registró sin nombre amigable                                | Editar el nombre desde Admin → Dashboard → overlay Dispositivos                                                  |
| El backend arranca pero dice `degraded` en `/health`                        | PostgreSQL o Redis no accesibles con las credenciales del `.env`                   | Revisar `docker compose logs gaga-backend`                                                                        |
| El backend falla al arrancar con "Configuración insegura"                    | Falta `JWT_SECRET` o `TELEMETRY_SHARED_SECRET` con `NODE_ENV=production`           | Completar ambas variables en `.env`                                                                              |
| `docker compose up -d --build` falla en `tsc --noEmit` o `vite build`       | Un cambio de código rompió el tipado de TypeScript                                 | El log de build señala archivo y línea - correr `npm run build` en local para iterar más rápido                  |
| `gaga-backend` se queda "unhealthy"/reiniciando en bucle                    | Postgres/Redis aún no listos, o credenciales no coinciden                          | Revisar `docker compose logs gaga-backend`; confirmar `.env`                                                     |
| Los `.mbtiles` no aparecen en `/tiles` tras el deploy                       | El mapa no se importó/activó en ese entorno - `maps_data` es propio de cada stack  | Importar y activar el mapa desde Admin → Dashboard → overlay Mapas en ese entorno                                 |
| Clonaste el repo de nuevo y aparece como instalación limpia                  | El proyecto de Docker Compose se resolvió con otro nombre, creando volúmenes nuevos | `docker-compose.yml` fija `name: gaga-gps-001` para evitar esto - revisar `docker volume ls` si ya pasó antes    |
| No se emite el certificado HTTPS                                             | DNS no apunta al host, o el puerto 80/443 está bloqueado                           | Crear los registros A/AAAA correspondientes y abrir `80/tcp` y `443/tcp`                                          |

## Visión a futuro

Dirección declarada del proyecto, no implementada todavía:

- **App móvil propia para operadores**, en reemplazo de Traccar
  Client - el backend ya es compatible (acepta el protocolo OsmAnd
  de cualquier cliente que lo hable), así que esto es una app nueva,
  no un cambio de protocolo. Incluiría:
  - Integración con RTK del dispositivo, si está disponible, para
    mejorar precisión.
  - Detección de mock-location (GPS falso/simulado) - anti-spoofing.
  - Permisos nativos de tableta (ubicación, direcciones, avisos) -
    la idea es un "Google Maps empresarial propio" para la
    operación, no solo un rastreador.
  - De construirse, el stack natural por consistencia sería React
    Native (reutilizando `packages/shared-types` y parte de
    `web/packages/client`) - todo el proyecto se mantiene en TypeScript
    de punta a punta deliberadamente, para no migrar a otro lenguaje
    cuando llegue este momento.
- **Más roles** - el sistema ya está preparado para esto sin cambios
  de schema (roles genéricos, ver [Autenticación y roles](#autenticación-y-roles));
  candidatos mencionados: `dispatcher`, `technician`.
- **Dirección real del chasis** (frente/reversa del vehículo) -
  evaluada y descartada por ahora vía el magnetómetro del
  dispositivo (fiabilidad insuficiente); retomar cuando exista
  integración de hardware del vehículo (señal de reversa/OBD-II).

## Limitaciones conocidas

- **Admin no puede tener proyecto asignado** - `project_id = NULL` es
  el único alcance válido para el rol Admin.
- Algunos módulos de alerta (`CollisionRiskService`,
  `VehicleProximityService`, `StaticEquipmentManager`,
  `PreventiveStopService`) siguen evaluando/emitiendo globalmente en
  memoria, sin filtrar por proyecto a nivel interno - el aislamiento
  por proyecto ya cubre REST, la posición en vivo y Geocercas, pero
  una alerta de colisión o una parada preventiva colectiva puede
  afectar a más de un proyecto a la vez.
- Las alertas activas que ve un Supervisor de Proyecto (colisión,
  proximidad, geocercas) son las de todo el proyecto, no solo las de
  su turno - el mapa/lista de vehículos sí está acotado a su turno.
- **Importador de mapas** - el modo "Mixto" es una superposición de
  opacidad (satelital sobre calles), no un estilo híbrido con
  etiquetas vectoriales. No hay cola de procesamiento - una
  importación a la vez.
- **Exportación a PDF** de reportes no está implementada - solo CSV.
- **Estimación de velocidad** - suavizado por EMA simple, no un
  filtro de Kalman con modelo de movimiento.
- **GPS local del navegador** (panel Operador) es un puente para
  operar offline hoy - no reemplaza RTK ni detecta mock-location; eso
  queda para la app móvil nativa planeada.
- **Battery Status API** - deprecada/restringida en varios
  navegadores (Chrome de escritorio ya no la expone); el dato de
  batería simplemente no aparece donde no está disponible.
- **Filtro de posiciones GPS** - el umbral adaptativo protege bien el
  caso dominante (maquinaria lenta); para un vehículo ligero que ya
  circula rápido, el margen relativo es más ancho.
