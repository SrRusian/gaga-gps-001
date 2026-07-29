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
6. [Instalación (desarrollo)](#instalación-desarrollo)
7. [Variables de entorno](#variables-de-entorno)
8. [Configurar Traccar Client en las tabletas](#configurar-traccar-client-en-las-tabletas)
9. [Referencia de la API](#referencia-de-la-api)
10. [Eventos de Socket.io en tiempo real](#eventos-de-socketio-en-tiempo-real)
11. [Módulos de seguridad (RF-ALR)](#módulos-de-seguridad-rf-alr)
12. [Seguridad del backend](#seguridad-del-backend)
13. [Retención y compresión de datos](#retención-y-compresión-de-datos)
14. [Panel de administración](#panel-de-administración)
15. [Acceso directo a PostgreSQL y Redis](#acceso-directo-a-postgresql-y-redis)
16. [Despliegue en producción](#despliegue-en-producción)
17. [Solución de problemas comunes](#solución-de-problemas-comunes)
18. [Limitaciones conocidas / trabajo futuro](#limitaciones-conocidas--trabajo-futuro)

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
| Contenerización | Docker + Docker Compose | Infraestructura de PostgreSQL/Redis (dev) y stack completo (prod) |
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
├── docker-compose.yml              # PostgreSQL + Redis para desarrollo local
├── docker-compose.prod.yml         # stack completo para producción (incluye backend)
└── README.md
```

## Modelo de datos

Definido en `db/migrations/001_init.sql`, aplicado automáticamente
la primera vez que se crea el volumen de PostgreSQL.

| Tabla | Propósito |
|---|---|
| `devices` | Dispositivos/tabletas — `unique_id` es el identificador que configuras en Traccar Client |
| `positions` | Hypertable de TimescaleDB — una fila por cada posición GPS recibida, particionada por `fix_time` |
| `geofences` | Geocercas circulares (centro + radio) — tipo `warning` (amarilla) o `danger` (roja) |
| `static_equipment` | Equipo estático (palas, excavadoras) con radio de giro y de seguridad |
| `users` | Usuarios del panel admin — roles `operator`, `supervisor`, `admin` |

## Instalación (desarrollo)

**Requisitos**: Docker Desktop, Node.js 22 LTS.

```bash
# 1. Clonar el repositorio
git clone https://github.com/SrRusian/gaga-gps-001.git
cd gaga-gps-001

# 2. Configurar variables de entorno
cp backend/.env-example backend/.env
# Editar backend/.env — ver sección "Variables de entorno" abajo

# 3. Levantar PostgreSQL + Redis (crea un volumen nuevo y vacío,
#    las migraciones de db/migrations/ se aplican automáticamente)
docker compose up -d

# 4. Instalar dependencias del backend
cd backend
npm install

# 5. Iniciar el backend
npm start

# 6. Crear tu primer usuario admin
npm run seed:admin -- admin@tuempresa.com TuPasswordSegura "Nombre Admin"
```

Con esto ya puedes iniciar sesión en `/admin` con esas credenciales.
Puedes crear más usuarios (operadores, supervisores, otros admins)
desde el propio panel una vez logueado — el script `seed:admin` solo
es necesario para el primer usuario, ya que el panel requiere estar
autenticado para crear nuevos usuarios.

### URLs del sistema

| Ruta | Descripción |
|---|---|
| `GET/POST http://localhost:3001/gps` | Receptor de telemetría (usado por las tabletas) |
| `http://localhost:3001/operator` | UI Operador |
| `http://localhost:3001/supervisor` | UI Supervisor |
| `http://localhost:3001/admin` | Panel de administración |
| `http://localhost:3001/health` | Health check (estado de Postgres/Redis) |

## Variables de entorno

Definidas en `backend/.env-example` — copiar a `backend/.env` (dev)
o `backend/.env.production` (prod) y completar.

| Variable | Obligatoria | Descripción |
|---|---|---|
| `DB_HOST` | Sí | Host de PostgreSQL (`localhost` en dev fuera de Docker, `postgres` dentro del stack Docker) |
| `DB_PORT` | Sí | Puerto de PostgreSQL (`5432`) |
| `DB_NAME` | Sí | Nombre de la base de datos (`gaga_gps`) |
| `DB_USER` | Sí | Usuario de PostgreSQL |
| `DB_PASSWORD` | Sí | Contraseña de PostgreSQL |
| `REDIS_HOST` | Sí | Host de Redis |
| `REDIS_PORT` | Sí | Puerto de Redis (`6379`) |
| `REDIS_PASSWORD` | Sí | Contraseña de Redis |
| `JWT_SECRET` | **Obligatoria en producción** | Firma de tokens del panel admin. El backend **falla al arrancar** si `NODE_ENV=production` y falta |
| `JWT_EXPIRES_IN` | No (default `8h`) | Vigencia del token de sesión del panel admin |
| `TELEMETRY_SHARED_SECRET` | **Obligatoria en producción** | Clave compartida para `/gps` — mitiga que terceros inyecten posiciones falsas. El backend falla al arrancar en producción si falta. Ver detalle en [Seguridad del backend](#seguridad-del-backend) |
| `PORT` | No (default `3001`) | Puerto HTTP del backend |
| `NODE_ENV` | Sí | `development` o `production` — activa validaciones estrictas de seguridad en `production` |
| `MAPS_DIR` | No (default `maps`) | Carpeta con los archivos `.mbtiles` servidos en `/tiles` |

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
| POST | `/api/auth/login` | No | Login — devuelve JWT |
| POST | `/api/auth/logout` | No | Logout (invalidación es responsabilidad del cliente) |
| GET | `/api/devices` | JWT | Listar dispositivos |
| GET | `/api/devices/:id` | JWT | Detalle de un dispositivo |
| POST | `/api/devices` | JWT | Crear dispositivo |
| PATCH | `/api/devices/:id` | JWT | Editar dispositivo |
| DELETE | `/api/devices/:id?force=true` | JWT | Eliminar dispositivo (`force=true` purga también su historial de posiciones; sin ese flag, responde 409 si tiene historial) |
| GET | `/api/geofences` | JWT | Listar geocercas activas |
| POST | `/api/geofences` | JWT | Crear geocerca |
| DELETE | `/api/geofences/:id` | JWT | Eliminar geocerca |
| GET | `/api/equipment` | JWT | Listar equipo estático |
| POST | `/api/equipment` | JWT | Crear equipo estático |
| PATCH | `/api/equipment/:id/status` | JWT | Cambiar estado (`active_swing` / `active_pause` / `inactive`) |
| DELETE | `/api/equipment/:id` | JWT | Eliminar equipo |
| GET | `/api/reports/history` | JWT | Historial de posiciones (JSON) por dispositivo y rango de fechas |
| GET | `/api/reports/history/csv` | JWT | Exportar historial a CSV (velocidad ya en km/h) |
| GET | `/api/users` | JWT (`admin`) | Listar usuarios |
| POST | `/api/users` | JWT (`admin`) | Crear usuario |
| PATCH | `/api/users/:id` | JWT (`admin`) | Editar usuario (nombre, rol, activo) |
| POST | `/api/users/:id/password` | JWT (`admin`) | Cambiar contraseña |
| DELETE | `/api/users/:id` | JWT (`admin`) | Eliminar usuario |
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

## Panel de administración

Accesible en `/admin` tras iniciar sesión (ver [Instalación](#instalación-desarrollo)
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

## Despliegue en producción

`docker-compose.prod.yml` levanta el stack completo (backend +
PostgreSQL + Redis) en contenedores:

```bash
cp backend/.env-example backend/.env.production
# Editar backend/.env.production con valores reales de producción

# DB_PASSWORD y REDIS_PASSWORD deben coincidir con las variables de
# entorno del shell/.env usadas por docker compose para interpolar
# los servicios postgres/redis (evita que backend y BD queden
# desincronizados en sus credenciales)
export DB_PASSWORD=...
export REDIS_PASSWORD=...

docker compose -f docker-compose.prod.yml up -d --build
```

Notas importantes:
- `NODE_ENV=production` activa validaciones estrictas — el backend
  **no arranca** si faltan `JWT_SECRET` o `TELEMETRY_SHARED_SECRET`.
- El diseño original contempla un reverse proxy HTTPS (Caddy) frente
  al backend para exponerlo con dominio propio — **no está incluido
  todavía** en `docker-compose.prod.yml` (ver limitaciones abajo).

## Solución de problemas comunes

| Síntoma | Causa probable | Solución |
|---|---|---|
| `NOAUTH Authentication required` (Redis) | Falta `REDIS_PASSWORD` en `.env` | Debe coincidir con `--requirepass` de `docker-compose.yml` |
| `Cannot GET /admin`, `/operator`, `/supervisor` | Backend corriendo fuera de la estructura esperada | Verificar que `ui-admin/`, `ui-operator/`, `ui-supervisor/` sean hermanos de `backend/` en la raíz del repo |
| `404` en Traccar Client al mandar posición | La tableta usa `POST` en vez de `GET` | Ya soportado — verificar que el backend esté actualizado (`router.post('/gps', ...)` en `telemetry.routes.js`) |
| `400` "Faltan parámetros requeridos" pese a que la tableta manda datos | Traccar Client envía los parámetros en el body (`form-urlencoded`), no en la URL | Ya soportado — requiere `express.urlencoded()` en `app.js` |
| `DELETE /api/devices/:id` responde 409 | El dispositivo tiene historial de posiciones (caso normal) | Usar `?force=true` si de verdad quieres purgar también el historial |
| Vehículo aparece en el mapa con nombre igual a su ID técnico | El dispositivo se auto-registró (nunca se le puso un nombre amigable) | Editar el nombre desde el panel Admin → Dispositivos |
| El backend arranca pero dice `degraded` en `/health` | PostgreSQL o Redis no están accesibles con las credenciales del `.env` | Revisar `DB_HOST`/`REDIS_HOST` — si el backend corre fuera de Docker, deben ser `localhost`, no `postgres`/`redis` |
| El backend falla al arrancar en producción con "Configuración insegura" | Falta `JWT_SECRET` o `TELEMETRY_SHARED_SECRET` en `.env.production` | Completar ambas variables — son obligatorias en `NODE_ENV=production` |

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
  no está incluido en `docker-compose.prod.yml` — el backend se
  expone hoy directamente en el puerto configurado.
- **Geocercas** son únicamente circulares (centro + radio), no
  soportan polígonos arbitrarios.
