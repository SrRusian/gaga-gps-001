# GAGA-GPS v2.0

Sistema de Geolocalización y Control de Flota en Tiempo Real para
operación minera — GAGA.

Sistema **propio** de telemetría GPS — **sin Traccar Server** como
intermediario. Las tabletas siguen usando la app **Traccar Client**
sin modificaciones (protocolo OsmAnd); solo cambia la URL del
servidor, que ahora apunta directamente a este backend Node.js.

> Este documento está pensado para que cualquier persona del equipo
> —nueva o veterana— entienda el proyecto completo: qué hace, cómo
> está construido, cómo instalarlo, configurarlo, desplegarlo y
> resolver problemas comunes.

---

## Tabla de contenido

1. [Visión general](#visión-general)
2. [Arquitectura](#arquitectura)
3. [Stack tecnológico](#stack-tecnológico)
4. [Estructura del proyecto](#estructura-del-proyecto)
5. [Modelo de datos](#modelo-de-datos)
6. [Instalación y despliegue](#instalación-y-despliegue)
7. [Variables de entorno](#variables-de-entorno)
8. [Configurar Traccar Client en las tabletas](#configurar-traccar-client-en-las-tabletas)
9. [Referencia de la API](#referencia-de-la-api)
10. [Eventos de Socket.io en tiempo real](#eventos-de-socketio-en-tiempo-real)
11. [Módulos de seguridad (RF-ALR)](#módulos-de-seguridad-rf-alr)
    - [Filtro de posiciones GPS (anti-teletransporte RTK/NTRIP)](#filtro-de-posiciones-gps-anti-teletransporte-rtkntrip)
12. [Seguridad del backend](#seguridad-del-backend)
13. [Retención y compresión de datos](#retención-y-compresión-de-datos)
14. [Panel de administración](#panel-de-administración)
15. [Acceso directo a PostgreSQL y Redis](#acceso-directo-a-postgresql-y-redis)
16. [Solución de problemas comunes](#solución-de-problemas-comunes)
17. [Limitaciones conocidas / trabajo futuro](#limitaciones-conocidas--trabajo-futuro)

---

## Visión general

GAGA-GPS rastrea en tiempo real una flota de vehículos/maquinaria
dentro de una operación minera, usando tabletas Android con la app
**Traccar Client** como dispositivos GPS. El backend recibe esa
telemetría directamente (sin pasar por un servidor Traccar), la
persiste, evalúa varias reglas de seguridad automáticas (geocercas,
anticolisión, pérdida de señal, aproximación a equipo pesado,
parada preventiva colectiva) y distribuye todo en tiempo real a
tres interfaces web:

- **Operador** (`/operator`) — vista en campo, en la tableta del
  vehículo: mapa, alertas, mi posición/velocidad.
- **Supervisor** (`/supervisor`) — vista de sala de control: toda
  la flota, alertas activas, botón de parada preventiva colectiva.
- **Admin** (`/admin`) — gestión: dispositivos, geocercas, equipo
  estático, usuarios, historial/reportes, estado del sistema.

## Arquitectura

```
Tableta (Traccar Client, protocolo OsmAnd)
        │ GET o POST /gps?id=...&lat=...&lon=...
        │ (o los mismos parámetros en el body, según versión de la app)
        ▼
backend/src/api/routes/telemetry.routes.js
        │ Valida clave compartida (opcional), parámetros, rango lat/lon
        ▼
backend/src/services/telemetry/PositionProcessor.js
        │ 1. Auto-registra el dispositivo si es nuevo (DeviceManager)
        │ 2. Persiste en PostgreSQL/TimescaleDB (PositionRepository)
        │ 3. Actualiza el estado en memoria (FleetStateManager → Redis)
        │ 4. Evalúa módulos de seguridad (geocercas, colisión, señal, equipo)
        │ 5. Distribuye vía Socket.io (FleetSocketServer)
        ▼
UI Operador / UI Supervisor / UI Admin (navegador)
```

No existe ya ningún componente Traccar Server, WebSocket externo ni
polling — todo el procesamiento ocurre de forma síncrona en el
momento en que llega la petición HTTP.

## Stack tecnológico

| Componente | Tecnología | Uso |
|---|---|---|
| Backend | Node.js 22 + Express 5 | API REST, receptor de telemetría, lógica de seguridad |
| Tiempo real | Socket.io 4 | Distribución de posiciones/alertas a las UIs |
| Base de datos | PostgreSQL 16 + TimescaleDB | Dispositivos, geocercas, equipo, usuarios, histórico de posiciones (hypertable) |
| Extensión espacial | PostGIS | Instalada pero **no utilizada actualmente** — los cálculos de distancia usan Haversine en JS (ver [Limitaciones conocidas](#limitaciones-conocidas--trabajo-futuro)) |
| Caché / estado en vivo | Redis 7 | Última posición conocida de cada dispositivo (no guarda histórico) |
| Autenticación | JWT (jsonwebtoken) + bcryptjs | Login del panel admin, con revalidación de usuario activo en cada request |
| Mapas | MapLibre GL + MBTiles (better-sqlite3) | Renderizado de mapas offline en las tabletas |
| Contenerización | Docker + Docker Compose | Stack completo (backend + UIs + PostgreSQL + Redis) con un solo `docker-compose.yml`, mismo para desarrollo y producción |
| Cliente GPS | Traccar Client (app de terceros, sin modificar) | Corre en las tabletas, protocolo OsmAnd |

## Estructura del proyecto

```
gaga-gps-001/
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── .env-example              # plantilla de variables de entorno
│   ├── scripts/
│   │   └── seed-admin.js         # crea/actualiza el primer usuario admin
│   └── src/
│       ├── app.js                # entry point — ensambla todo
│       ├── config/                # pool de PostgreSQL, cliente Redis, env
│       ├── repositories/          # acceso a datos (CRUD PostgreSQL)
│       ├── services/
│       │   ├── telemetry/         # PositionProcessor, DeviceManager, FleetStateManager
│       │   ├── alerts/            # los 5 módulos de seguridad (no se modifican)
│       │   ├── static_equipment/  # gestión de equipo estático
│       │   └── maps/              # pipeline de imágenes georreferenciadas → MBTiles
│       ├── sockets/                # FleetSocketServer (Socket.io)
│       └── api/
│           ├── routes/             # un archivo por recurso (ver tabla de endpoints)
│           └── middleware/         # auth, rate limiting, logger
│
├── db/
│   └── migrations/                 # SQL versionado, se aplica solo en Postgres nuevo
│       ├── 001_init.sql            # schema completo
│       └── 002_retention_and_compression.sql
│
├── ui-operator/index.html          # SPA vanilla — vista en campo
├── ui-supervisor/index.html        # SPA vanilla — sala de control
├── ui-admin/index.html             # SPA vanilla — panel de administración
│
├── maps/                           # archivos .mbtiles generados (no versionados)
├── TEST-FILES/                     # imágenes de muestra para el pipeline de mapas (no versionado)
│
├── docker-compose.yml              # stack completo (backend + UIs + Postgres + Redis) — dev y producción
├── .dockerignore                   # contexto de build = raíz del repo (ver backend/Dockerfile)
├── .env.example                    # única plantilla de variables — copiar a .env y editar
└── README.md
```

## Modelo de datos

Definido en `db/migrations/` (se aplica automáticamente, en orden,
la primera vez que se crea el volumen de PostgreSQL).

| Tabla | Propósito |
|---|---|
| `devices` | Dispositivos/tabletas — `unique_id` es el identificador que configuras en Traccar Client |
| `positions` | Hypertable de TimescaleDB — una fila por cada posición GPS recibida, particionada por `fix_time` |
| `geofences` | Geocercas — círculo, polígono o polilínea/corredor (ver [Geocercas avanzadas](#geocercas-avanzadas-círculo-polígono-ruta)) — tipo `warning` (amarilla) o `danger` (roja) |
| `geofence_events` | Auditoría de entradas/salidas de geocercas (`003_geofence_shapes.sql`) |
| `static_equipment` | Equipo estático (palas, excavadoras) con radio de giro y de seguridad |
| `users` | Usuarios del panel admin — roles `operator`, `supervisor`, `admin` |

## Geocercas avanzadas (círculo, polígono, ruta)

Además del círculo original (centro + radio), el sistema soporta:

- **Polígono** — zona autorizada de forma arbitraria, dibujada
  directamente en el mapa del panel Admin.
- **Polilínea / corredor** — ruta autorizada con un ancho definido
  a cada lado (`corridorWidthMeters`); útil para marcar el camino
  por el que debe circular la maquinaria.

Todas se evalúan en tiempo real con la misma lógica de alertas
(`GeofenceAlertService` + `backend/src/utils/geometry.js`, sin
depender de PostGIS) y cada entrada/salida queda registrada en
`geofence_events` para auditoría/reportes.

**Panel Admin → Geocercas**:
- Selector "Forma" para elegir círculo/polígono/ruta antes de dibujar.
- Mapa con calles reales (OSM) o modo offline (MBTiles), intercambiable
  con un botón — útil si el sitio no tiene conectividad.
- Exportar/Importar en **GeoJSON** (estándar principal, nativo en
  JS/QGIS/Leaflet/Mapbox) o **KML** (Google Earth, muy usado en
  topografía/minería) — botones directos en el panel.

## Visor de recorridos por día

**Panel Admin → Historial** dibuja el recorrido completo de un
vehículo en un rango de fechas como una línea sobre el mapa,
coloreada según si el vehículo estaba dentro de una zona/ruta
autorizada (verde) o fuera de todas (rojo) — usa
`GET /api/reports/history-with-zones`, que cruza cada posición
contra las geocercas activas con la misma lógica de
`GeofenceAlertService`.

Incluye reproducción animada (▶️/⏸️) con control deslizante para
avanzar manualmente punto por punto, mostrando fecha/hora y
velocidad de cada uno.

## Instalación y despliegue

Un único flujo, con **un solo comando**, para desarrollo local o
para producción en un servidor — no hay archivos ni pasos
distintos entre entornos. Todo el sistema (backend + las 3 UIs +
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
# Editar .env — como mínimo cambia DB_PASSWORD, REDIS_PASSWORD,
# JWT_SECRET y TELEMETRY_SHARED_SECRET

# 3. Levantar TODO el stack (build de la imagen del backend +
#    Postgres + Redis; las migraciones de db/migrations/ se aplican
#    automáticamente la primera vez que se crea el volumen)
docker compose up -d --build

# 4. Crear tu primer usuario admin (dentro del contenedor)
docker compose exec gaga-backend \
  npm run seed:admin -- admin@tuempresa.com TuPasswordSegura "Nombre Admin"
```

Con esto ya puedes iniciar sesión en `/admin` con esas credenciales.
Puedes crear más usuarios (operadores, supervisores, otros admins)
desde el propio panel una vez logueado — el script `seed:admin` solo
es necesario para el primer usuario, ya que el panel requiere estar
autenticado para crear nuevos usuarios.

Para actualizar tras un cambio de código:
```bash
git pull
docker compose up -d --build
```

Notas:
- `NODE_ENV=production` (default en `.env.example`) activa
  validaciones estrictas — el backend **no arranca** si faltan
  `JWT_SECRET` o `TELEMETRY_SHARED_SECRET`. Usa `NODE_ENV=development`
  en `.env` si estás iterando localmente y quieres omitir esa
  validación.
- `gaga-backend` depende de que `postgres` y `redis` pasen su
  healthcheck antes de arrancar, y expone su propio healthcheck en
  `/health` (visible en `docker compose ps`).
- El volumen `./maps:/app/maps` persiste los `.mbtiles` fuera del
  contenedor — colócalos ahí manualmente si tu operación usa mapas
  offline (`cp /ruta/a/tus/*.mbtiles maps/`).
- El diseño original contempla un reverse proxy HTTPS (Caddy) frente
  al backend para exponerlo con dominio propio en producción — **no
  está incluido todavía** en `docker-compose.yml` (ver limitaciones
  al final del documento).

### Alternativa: correr el backend sin Docker (avanzado)

Para iteración rápida con hot-reload durante desarrollo activo del
código, puedes correr el backend directo con `node`, apuntando a un
Postgres/Redis que sigues levantando con Docker:

```bash
docker compose up -d postgres redis   # solo las dependencias
cp backend/.env-example backend/.env  # plantilla separada, ver el archivo
cd backend
npm install
npm start
npm run seed:admin -- admin@tuempresa.com TuPasswordSegura "Nombre Admin"
```

Este flujo es opcional y no forma parte del despliegue estándar.

### URLs del sistema

| Ruta | Descripción |
|---|---|
| `GET/POST http://localhost:3001/gps` | Receptor de telemetría (usado por las tabletas) |
| `http://localhost:3001/operator` | UI Operador |
| `http://localhost:3001/supervisor` | UI Supervisor |
| `http://localhost:3001/admin` | Panel de administración |
| `http://localhost:3001/health` | Health check (estado de Postgres/Redis) |

## Variables de entorno

Todas definidas en un único archivo — [.env.example](.env.example)
(raíz) — copiar a `.env` y completar. Es el mismo archivo para
desarrollo con Docker y para producción; lo único que cambia según
el entorno es el valor de `NODE_ENV`.

`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `REDIS_HOST` y
`REDIS_PORT` **no** están en `.env`: son fijos dentro de la red
Docker (`docker-compose.yml` los define directamente como
`postgres`/`redis`, los nombres de los servicios) y no hace falta
tocarlos.

| Variable | Obligatoria | Descripción |
|---|---|---|
| `DB_PASSWORD` | Sí | Contraseña de PostgreSQL |
| `REDIS_PASSWORD` | Sí | Contraseña de Redis |
| `NODE_ENV` | Sí | `development` o `production` — activa validaciones estrictas de seguridad en `production` |
| `JWT_SECRET` | **Obligatoria en producción** | Firma de tokens del panel admin. El backend **falla al arrancar** si `NODE_ENV=production` y falta |
| `TELEMETRY_SHARED_SECRET` | **Obligatoria en producción** | Clave compartida para `/gps` — mitiga que terceros inyecten posiciones falsas. El backend falla al arrancar en producción si falta. Ver detalle en [Seguridad del backend](#seguridad-del-backend) |
| `JWT_EXPIRES_IN` | No (default `8h`) | Vigencia del token de sesión del panel admin |
| `OPERATOR_JWT_EXPIRES_IN` | No (default `30d`) | Vigencia del token de la UI de operador — ver [Turnos de operador](#turnos-de-operador-y-vinculación-de-dispositivo) |
| `OPERATOR_SESSION_MAX_IDLE_DAYS` | No (default `7`) | Días sin heartbeat tras los cuales se cierra automáticamente un turno abandonado |
| `MAPS_DIR` | No (default `maps`) | Carpeta con los archivos `.mbtiles` servidos en `/tiles` |
| `POSITION_FILTER_TOLERANCE_FACTOR` | No (default `1.8`) | Margen sobre la velocidad reciente del dispositivo antes de considerar un salto sospechoso — ver [Filtro de posiciones GPS](#filtro-de-posiciones-gps-anti-teletransporte-rtkntrip) |
| `POSITION_FILTER_MIN_FLOOR_KMH` | No (default `25`) | Piso mínimo (km/h) del umbral adaptativo — headroom para arrancar desde parado |
| `POSITION_FILTER_ABSOLUTE_CEILING_KMH` | No (default `120`) | Techo de seguridad (km/h) del umbral adaptativo |
| `POSITION_FILTER_JITTER_RADIUS_M` | No (default `5`) | Radio (metros) de ruido GPS normal con el vehículo detenido |
| `POSITION_FILTER_HISTORY_WINDOW` | No (default `8`) | Cuántas velocidades recientes se recuerdan por dispositivo |
| `POSITION_FILTER_MAX_CONSECUTIVE_REJECTS` | No (default `3`) | Rechazos consecutivos antes de resincronizar (fail-open) |

## Configurar Traccar Client en las tabletas

En la app **Traccar Client** (Android/iOS), configurar:

- **Device Identifier**: cualquier texto único para ese vehículo/
  equipo (ej. `CAMION-01`). Se convierte en `unique_id` en la tabla
  `devices` — recomendamos usar el mismo valor al registrar el
  dispositivo en el panel Admin, para que quede con un nombre
  amigable desde el primer reporte.
- **Server URL**: URL completa hasta `/gps` — **no** uses `localhost`
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
  intervalo de 15-20 segundos como referencia general — el sistema
  también soporta reportes mucho más frecuentes (hasta 1/segundo)
  gracias a la política de compresión de datos (ver más abajo).

El backend acepta indistintamente `GET` o `POST`, y los parámetros
ya sea en la URL (query string) o en el cuerpo de la petición
(`application/x-www-form-urlencoded`) — distintas versiones de
Traccar Client usan una u otra forma.

## Referencia de la API

Todas las rutas bajo `/api/*` (excepto `/api/auth/login` y
`/api/fleet/*`) requieren header `Authorization: Bearer <token>`
obtenido en el login.

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET/POST | `/gps` | Clave compartida opcional | Receptor de telemetría (protocolo OsmAnd) |
| GET | `/tiles/alcaraces/:z/:x/:y.png` | No | Tiles de mapa offline (MBTiles) |
| POST | `/api/auth/login` | No | Login — devuelve JWT. Body opcional `longLived: true` para tokens de larga duración (ver Turnos de operador) |
| POST | `/api/auth/logout` | No | Logout (invalidación es responsabilidad del cliente) |
| GET | `/api/devices/lookup/:uniqueId` | No | Verifica si un dispositivo existe y si tiene turno activo — usado por la pantalla de configuración de ui-operator |
| GET | `/api/devices` | JWT | Listar dispositivos |
| GET | `/api/devices/:id` | JWT | Detalle de un dispositivo |
| POST | `/api/devices` | JWT | Crear dispositivo |
| PATCH | `/api/devices/:id` | JWT | Editar dispositivo |
| DELETE | `/api/devices/:id?force=true` | JWT | Eliminar dispositivo (`force=true` purga también su historial de posiciones; sin ese flag, responde 409 si tiene historial) |
| GET | `/api/geofences` | JWT | Listar geocercas activas (cualquier forma) |
| POST | `/api/geofences` | JWT | Crear geocerca — `shapeType`: `circle` \| `polygon` \| `polyline` |
| DELETE | `/api/geofences/:id` | JWT | Eliminar geocerca |
| GET | `/api/geofences/export.geojson` | JWT | Exportar todas las geocercas activas en GeoJSON |
| GET | `/api/geofences/export.kml` | JWT | Exportar todas las geocercas activas en KML |
| POST | `/api/geofences/import` | JWT | Importar geocercas — body `{ format: 'geojson'\|'kml', data }` |
| GET | `/api/equipment` | JWT | Listar equipo estático |
| POST | `/api/equipment` | JWT | Crear equipo estático |
| PATCH | `/api/equipment/:id/status` | JWT | Cambiar estado (`active_swing` / `active_pause` / `inactive`) |
| DELETE | `/api/equipment/:id` | JWT | Eliminar equipo |
| GET | `/api/reports/history` | JWT | Historial de posiciones (JSON) por dispositivo y rango de fechas |
| GET | `/api/reports/history-with-zones` | JWT | Igual que `/history`, anotando en qué geocerca estaba cada posición (usado por el visor de recorridos) |
| GET | `/api/reports/history/csv` | JWT | Exportar historial a CSV (velocidad ya en km/h) |
| GET | `/api/users` | JWT (`admin`) | Listar usuarios |
| POST | `/api/users` | JWT (`admin`) | Crear usuario |
| PATCH | `/api/users/:id` | JWT (`admin`) | Editar usuario (nombre, rol, activo) |
| POST | `/api/users/:id/password` | JWT (`admin`) | Cambiar contraseña |
| DELETE | `/api/users/:id` | JWT (`admin`) | Eliminar usuario |
| GET | `/api/operator-sessions/active?deviceId=` | No | Turno activo (si lo hay) de un dispositivo |
| POST | `/api/operator-sessions/start` | JWT | Inicia turno del usuario autenticado en un dispositivo (cierra automáticamente cualquier turno previo abierto de ese dispositivo) |
| POST | `/api/operator-sessions/:id/end` | JWT | Cierra el turno explícitamente |
| POST | `/api/operator-sessions/:id/heartbeat` | JWT | Marca actividad reciente — evita el cierre automático por inactividad |
| GET | `/api/operator-sessions/report` | JWT (`admin`/`supervisor`) | Reporte de turnos por operador y/o dispositivo, con duración |
| GET | `/api/fleet/state` | No | Estado actual de toda la flota (lectura desde Redis) |
| POST | `/api/fleet/stop` | No | Activar parada preventiva colectiva |
| POST | `/api/fleet/resume` | No | Desactivar parada preventiva (solo supervisor) |
| GET | `/api/fleet/stop/status` | No | Estado actual de la parada preventiva |
| GET | `/health` | No | Estado de PostgreSQL/Redis y de la parada preventiva |

> `/api/fleet/*` no requiere JWT porque las UIs de Operador/Supervisor
> se usan en campo/sala de control sin login individual — mismo
> comportamiento que tenía el sistema antes de esta migración.

## Eventos de Socket.io en tiempo real

El servidor emite (y las UIs escuchan) estos eventos:

| Evento | Origen | Descripción |
|---|---|---|
| `fleet:update` | PositionProcessor / FleetSocketServer | Nueva posición de uno o más vehículos |
| `geofences:update` | geofences.routes / FleetSocketServer | Lista de geocercas activas actualizada |
| `equipment:update` | equipment.routes | Lista de equipo estático actualizada |
| `alert:critical` / `alert:warning` / `alert:clear` | GeofenceAlertService | Alertas de geocerca al dispositivo afectado |
| `supervisor:alert` | GeofenceAlertService | Notificación de geocerca al panel de supervisor |
| `signal:lost:level1` / `signal:lost:level2` / `signal:recovered` | SignalLostService | Pérdida/recuperación de señal de un vehículo |
| `supervisor:signal_lost` | SignalLostService | Notificación de pérdida de señal al supervisor |
| `collision:proximity` / `collision:critical` / `collision:clear` | CollisionRiskService | Riesgo de colisión entre vehículos |
| `supervisor:collision` | CollisionRiskService | Notificación de riesgo de colisión al supervisor |
| `fleet:preventive_stop` / `fleet:preventive_stop_clear` | PreventiveStopService | Activación/cancelación de parada preventiva colectiva |
| `supervisor:preventive_stop` | PreventiveStopService | Notificación al supervisor |
| `equipment:approach_outer` / `equipment:approach_inner` / `equipment:minimum_limit` / `equipment:distance_update` / `equipment:approach_clear` | StaticEquipmentManager | Guía de aproximación a equipo estático |
| `equipment:status_update` | StaticEquipmentManager | Cambio de estado de un equipo (`active_swing`/`active_pause`/`inactive`) |
| `equipment:vehicle_approaching` | StaticEquipmentManager | Notificación al operador del equipo estático |

## Módulos de seguridad (RF-ALR)

Estos 5 módulos existían antes de la migración y **no se modificaron**
— solo cambió dónde se invocan (antes desde `TraccarWsClient.js`,
ahora desde `PositionProcessor.js`):

| Módulo | RF | Función |
|---|---|---|
| `GeofenceAlertService` | RF-ALR-02/03 | Alerta al entrar en zona amarilla (advertencia) o roja (peligro) |
| `SignalLostService` | RF-ALR-05 | Nivel 1 (45s sin señal) y Nivel 2 (90s, activa parada preventiva automática) |
| `CollisionRiskService` | RF-ALR-10 | Anticolisión — distancia + trayectoria proyectada entre vehículos |
| `PreventiveStopService` | RF-ALR-11 | Parada preventiva colectiva — solo el supervisor puede desactivarla |
| `StaticEquipmentManager` | RF-ALR-12 | Guía de aproximación a equipo estático con radio de giro |

### Filtro de posiciones GPS (anti-teletransporte RTK/NTRIP)

Cuando el receptor RTK pierde momentáneamente la corrección
(satélite o NTRIP, típicamente ~1 segundo), puede reportar un punto
a decenas de metros de la ruta real y luego el siguiente fix vuelve
a la posición correcta — un "teletransporte" visible en el mapa que,
sin filtrar, también podría alimentar geocercas/colisión con datos
falsos.

`PositionFilterService.js` corre dentro de `PositionProcessor.js`,
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
`distanceMeters`) — quedan disponibles para auditar y afinar el
umbral, pero **nunca** aparecen en el mapa en vivo, el historial ni
los reportes/CSV (`PositionRepository` filtra `valid = TRUE` en
todas sus consultas de lectura).

Si un dispositivo encadena varios rechazos seguidos
(`POSITION_FILTER_MAX_CONSECUTIVE_REJECTS`, default 3), el filtro
se resincroniza automáticamente en vez de dejarlo "congelado" fuera
del mapa — asume que de verdad se movió o volvió a tener señal más
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
y tienen default — ver [Variables de entorno](#variables-de-entorno).

## Seguridad del backend

- **JWT con revalidación activa**: cada request protegido no solo
  valida la firma/expiración del token, también consulta PostgreSQL
  para confirmar que el usuario sigue `active` y conserva el mismo
  rol — si un admin desactiva a alguien, su sesión se corta de
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
  claro por defecto, en vez de un error genérico — requiere
  `?force=true` explícito para purgar también su historial.

## Retención y compresión de datos

Las tabletas pueden reportar posición cada 1 segundo, lo que puede
generar cientos de millones de filas al año con flotas grandes. La
hypertable `positions` (TimescaleDB) tiene configurada una política
automática (`db/migrations/002_retention_and_compression.sql`):

- **Compresión** — chunks con datos de más de 7 días se comprimen
  automáticamente en segundo plano (10-20x menos espacio en disco),
  sin afectar las consultas de historial/reportes recientes.
- **Retención** — chunks con datos de más de 1 año se eliminan
  automáticamente para liberar espacio.

Redis **no** requiere política de retención — solo guarda la última
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

| Flota | Frecuencia | Espacio/año (comprimido) |
|---|---|---|
| 1 vehículo | cada 1s | ~0.5 GB |
| 10 vehículos | cada 1s | ~4-6 GB |
| 50 vehículos | cada 1s | ~20-30 GB |

## Turnos de operador y vinculación de dispositivo

Separa dos identidades que no deben mezclarse — el mismo patrón que
usan sistemas de flotillas profesionales (Samsara, Geotab):

- **Identidad del vehículo/tableta** — fija por configuración de
  kiosco, no por login. Se resuelve leyendo `?device=X` en la URL
  de `ui-operator` (configurado una sola vez por el técnico que
  instala la tableta, p. ej. como acceso directo/kiosco en Android),
  con fallback a `localStorage`. Si no hay ninguno configurado, se
  muestra una pantalla de configuración que **valida contra el
  sistema** (`GET /api/devices/lookup/:uniqueId`) antes de continuar
  — evita que un ID inventado o mal tecleado avance hasta el login,
  y advierte (sin bloquear) si ese dispositivo ya tiene un turno
  activo con otro operador, para detectar identificadores duplicados
  entre tabletas.
- **Identidad del operador** — turno de trabajo independiente,
  registrado en `operator_sessions` (login con el mismo sistema de
  usuarios/JWT del panel admin). Un mismo operador puede iniciar
  turno en máquinas distintas en momentos distintos — el sistema
  lleva el registro por separado, permitiendo reportar tanto
  "¿quién operó este vehículo?" como "¿cuántas horas trabajó esta
  persona, en qué máquinas?" (`GET /api/operator-sessions/report`).

**Persistencia del turno**: el login del operador usa un JWT de
larga duración (`OPERATOR_JWT_EXPIRES_IN`, 30 días por defecto) —
distinto al del panel admin (`JWT_EXPIRES_IN`, 8h) — para no forzar
re-login constante. Mientras la pestaña siga abierta, `ui-operator`
envía un heartbeat cada 5 minutos (`POST /api/operator-sessions/:id/heartbeat`).
Si un turno deja de recibir heartbeats por más de
`OPERATOR_SESSION_MAX_IDLE_DAYS` (7 días por defecto — tableta
perdida, app cerrada sin cerrar turno), el backend lo cierra
automáticamente en segundo plano.

## Panel de administración

Accesible en `/admin` tras iniciar sesión (ver [Instalación y despliegue](#instalación-y-despliegue)
para crear el primer usuario). Secciones:

- **Dashboard** — métricas globales de la flota.
- **Dispositivos** — alta/edición/baja de tabletas.
- **Geocercas** — crear/eliminar geocercas haciendo clic en el mapa.
- **Equipo estático** — registrar palas/excavadoras con radio de giro.
- **Historial** — consulta de posiciones pasadas por dispositivo y rango de fechas.
- **Reportes** — exportación a CSV.
- **Usuarios** — gestión de cuentas y roles (solo accesible por `admin`).
- **Sistema** — health check en vivo.

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

**Redis** (contenedor `gaga-redis`, puerto `6379`) — solo contiene
el estado en tiempo real de la flota, no histórico:
```bash
docker exec -it gaga-redis redis-cli -a <REDIS_PASSWORD>
```
```
HGETALL gaga:fleet:state     # estado actual de toda la flota (JSON por dispositivo)
```

## Solución de problemas comunes

| Síntoma | Causa probable | Solución |
|---|---|---|
| `NOAUTH Authentication required` (Redis) | Falta `REDIS_PASSWORD` en `.env` | Debe coincidir con lo que arrancó el contenedor `gaga-redis` (`docker compose up -d --build` para aplicar cambios de `.env`) |
| `Cannot GET /admin`, `/operator`, `/supervisor` | Backend corriendo fuera de la estructura esperada | Verificar que `ui-admin/`, `ui-operator/`, `ui-supervisor/` sean hermanos de `backend/` en la raíz del repo |
| `404` en Traccar Client al mandar posición | La tableta usa `POST` en vez de `GET` | Ya soportado — verificar que el backend esté actualizado (`router.post('/gps', ...)` en `telemetry.routes.js`) |
| `400` "Faltan parámetros requeridos" pese a que la tableta manda datos | Traccar Client envía los parámetros en el body (`form-urlencoded`), no en la URL | Ya soportado — requiere `express.urlencoded()` en `app.js` |
| `DELETE /api/devices/:id` responde 409 | El dispositivo tiene historial de posiciones (caso normal) | Usar `?force=true` si de verdad quieres purgar también el historial |
| Vehículo aparece en el mapa con nombre igual a su ID técnico | El dispositivo se auto-registró (nunca se le puso un nombre amigable) | Editar el nombre desde el panel Admin → Dispositivos |
| El backend arranca pero dice `degraded` en `/health` | PostgreSQL o Redis no están accesibles con las credenciales del `.env` | Revisar `docker compose logs gaga-backend`; si corres el backend fuera de Docker (flujo avanzado), `DB_HOST`/`REDIS_HOST` deben ser `localhost` en `backend/.env` |
| El backend falla al arrancar con "Configuración insegura" | Falta `JWT_SECRET` o `TELEMETRY_SHARED_SECRET` en `.env` y `NODE_ENV=production` | Completar ambas variables en `.env` — son obligatorias en `NODE_ENV=production` |
| `docker compose up -d --build` falla compilando `better-sqlite3` | Faltan herramientas de build en la imagen | Ya cubierto — `backend/Dockerfile` instala `python3 make g++` en la etapa de dependencias |
| `gaga-backend` se queda "unhealthy"/reiniciando en bucle | Postgres/Redis aún no listos, o credenciales no coinciden | Revisar `docker compose logs gaga-backend`; confirmar que `.env` tiene las contraseñas correctas y coincide con el contenedor ya arrancado |
| Los `.mbtiles` no aparecen en `/tiles` tras el deploy | No se colocaron en `maps/` en el host, o el volumen no está montado | Copiar los archivos a `./maps/` en el servidor — se montan como volumen (`./maps:/app/maps`), no van dentro de la imagen |

## Limitaciones conocidas / trabajo futuro

- **PostGIS** está instalado (`CREATE EXTENSION postgis`) pero
  **no se usa** — todos los cálculos de distancia/geocercas usan
  la fórmula de Haversine en JavaScript sobre columnas
  `DOUBLE PRECISION` planas. Queda disponible para el futuro si se
  requieren geocercas poligonales (`ST_Contains`, tipos `geography`).
- **`MapPipelineService.js`** (pipeline de imagen georreferenciada →
  MBTiles) existe como servicio pero **no está expuesto por ninguna
  ruta de la API todavía** — hoy los `.mbtiles` se generan/colocan
  manualmente en `maps/`.
- **Exportación a PDF** de reportes no está implementada — solo CSV.
- **Reverse proxy HTTPS (Caddy)** contemplado en el diseño original
  no está incluido en `docker-compose.yml` — el backend se
  expone hoy directamente en el puerto configurado.
- **Geocercas** son únicamente circulares (centro + radio), no
  soportan polígonos arbitrarios.
- **Filtro de posiciones GPS** — el umbral adaptativo (ver
  [Filtro de posiciones GPS](#filtro-de-posiciones-gps-anti-teletransporte-rtkntrip))
  protege muy bien el caso dominante (maquinaria lenta), pero para
  un vehículo ligero que ya circula rápido el margen relativo es
  más ancho, así que haría falta un salto proporcionalmente mayor
  para dispararlo. Los rechazos quedan auditables
  (`positions.valid = false`) para afinar
  `POSITION_FILTER_TOLERANCE_FACTOR`/`POSITION_FILTER_ABSOLUTE_CEILING_KMH`
  con datos reales, sin tocar código.
