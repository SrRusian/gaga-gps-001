-- 001_init.sql
--
-- Schema completo de GAGA-GPS — un solo archivo, sin pasos
-- incrementales. Se aplica una sola vez, automáticamente, la
-- primera vez que se crea el volumen de PostgreSQL (comportamiento
-- estándar de la imagen oficial: todo `.sql` en
-- /docker-entrypoint-initdb.d se ejecuta solo si el volumen está
-- vacío). En este proyecto no existe historial de producción que
-- migrar de forma incremental (todavía es un entorno de prueba), así
-- que no tiene sentido cargar el arranque con `ALTER TABLE` que
-- reconstruyen un camino que nadie va a recorrer — este archivo
-- crea directamente el estado final.
--
-- Si en el futuro ya hay datos reales en producción y hace falta
-- cambiar el schema, la forma correcta es agregar un archivo nuevo
-- (002_lo_que_sea.sql) con el `ALTER TABLE` puntual — nunca editar
-- este archivo una vez que exista una base de datos real, porque
-- solo se ejecuta en un volumen vacío y un cambio aquí no le llegaría
-- a nadie que ya esté corriendo el sistema.
--
-- Requiere las extensiones PostGIS y TimescaleDB en la imagen de
-- Postgres (timescale/timescaledb-ha, ver docker-compose.yml).

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Zona horaria de presentación de la base — la operación es de un
-- solo sitio (Colima, México). No afecta lo guardado: TIMESTAMPTZ
-- siempre representa el mismo instante real sin importar la zona de
-- sesión; esto solo cambia cómo se ve al consultar por psql/DBeaver
-- directo (el backend nunca formatea fechas como texto, así que no
-- le afecta).
ALTER DATABASE gaga_gps SET timezone TO 'America/Mexico_City';

-- ─────────────────────────────────────────────────────────────
-- Dispositivos (tabletas Traccar Client)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
  id          SERIAL PRIMARY KEY,
  unique_id   VARCHAR(255) UNIQUE NOT NULL,
  name        VARCHAR(255) NOT NULL,
  type        VARCHAR(50) DEFAULT 'vehicle',
  status      VARCHAR(20) DEFAULT 'offline',
  last_update TIMESTAMPTZ,
  attributes  JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- Usuarios — todos los roles requieren cuenta con correo y
-- contraseña (admin, supervisor, operator, y cualquier rol que se
-- agregue a futuro). `role` es un VARCHAR libre, sin CHECK — agregar
-- un rol nuevo es configuración de la aplicación (requireRole() en
-- las rutas del backend, el <select> de Admin → Usuarios), no un
-- cambio de schema.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) UNIQUE NOT NULL,
  password   VARCHAR(255) NOT NULL,
  name       VARCHAR(255) NOT NULL,
  role       VARCHAR(20) DEFAULT 'operator',
  active     BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- Posiciones — hypertable de TimescaleDB particionada por tiempo
-- (fix_time), con compresión y retención automáticas.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS positions (
  id          BIGSERIAL,
  device_id   VARCHAR(255) NOT NULL REFERENCES devices(unique_id),
  latitude    DOUBLE PRECISION NOT NULL,
  longitude   DOUBLE PRECISION NOT NULL,
  altitude    DOUBLE PRECISION DEFAULT 0,
  speed       DOUBLE PRECISION DEFAULT 0,
  course      DOUBLE PRECISION DEFAULT 0,
  accuracy    DOUBLE PRECISION DEFAULT 0,
  battery     DOUBLE PRECISION,
  fix_time    TIMESTAMPTZ NOT NULL,
  server_time TIMESTAMPTZ DEFAULT NOW(),
  protocol    VARCHAR(20) DEFAULT 'osmand',
  valid       BOOLEAN DEFAULT TRUE,
  attributes  JSONB DEFAULT '{}',
  PRIMARY KEY (id, fix_time)
);

-- create_hypertable requiere que fix_time forme parte de la PK (arriba)
SELECT create_hypertable('positions', 'fix_time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_positions_device_time ON positions (device_id, fix_time DESC);

-- Compresión y retención — TimescaleDB no tiene una sintaxis de
-- CREATE TABLE para esto, siempre se configura con ALTER TABLE SET
-- justo después de crear la hypertable (no es una "migración",
-- es la única API que ofrece TimescaleDB). Últimos 7 días sin
-- comprimir (historial reciente, se consulta seguido); más de un
-- año se purga automáticamente. Ajustar según política de retención
-- real de la operación.
ALTER TABLE positions SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id',
  timescaledb.compress_orderby = 'fix_time DESC'
);
SELECT add_compression_policy('positions', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('positions', INTERVAL '1 year', if_not_exists => TRUE);

-- ─────────────────────────────────────────────────────────────
-- Snapshots de sensores del navegador — batería, red, memoria,
-- pantalla, orientación/movimiento, almacenamiento, etc. Cuerpo
-- libre en JSONB (mismo criterio que `attributes` arriba) porque
-- el set de sensores disponibles crece/cambia con cada navegador
-- y no vale la pena una columna por sensor. Hypertable propia,
-- separada de `positions`, porque el operador la reporta con su
-- propio ciclo (cada 30s) independiente de cada fix GPS.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_sensor_snapshots (
  id          BIGSERIAL,
  device_id   VARCHAR(255) NOT NULL REFERENCES devices(unique_id),
  source      VARCHAR(20) NOT NULL DEFAULT 'browser',
  data        JSONB NOT NULL DEFAULT '{}',
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, captured_at)
);

SELECT create_hypertable('device_sensor_snapshots', 'captured_at', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_sensor_snapshots_device_time
  ON device_sensor_snapshots (device_id, captured_at DESC);

-- Igual que `positions`: comprime lo viejo, purga lo muy viejo —
-- son datos exploratorios/de diagnóstico, no historial operativo
-- crítico, así que la retención puede ser más corta.
ALTER TABLE device_sensor_snapshots SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id',
  timescaledb.compress_orderby = 'captured_at DESC'
);
SELECT add_compression_policy('device_sensor_snapshots', INTERVAL '1 day', if_not_exists => TRUE);
SELECT add_retention_policy('device_sensor_snapshots', INTERVAL '30 days', if_not_exists => TRUE);

-- ─────────────────────────────────────────────────────────────
-- Geocercas — círculo, polígono o polilínea/corredor.
-- Círculo usa center_lat/center_lon/radius_meters; polígono y
-- polilínea usan `geometry` en GeoJSON (JSONB) — estándar de facto
-- para geometría en JSON, compatible con QGIS/Leaflet/MapLibre, sin
-- necesidad de PostGIS. corridor_width_meters/corridor_danger_margin_meters
-- solo aplican a polilínea (ancho del corredor autorizado y margen
-- de advertencia antes de salirse de la ruta).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS geofences (
  id                             SERIAL PRIMARY KEY,
  name                           VARCHAR(255) NOT NULL,
  type                           VARCHAR(20) NOT NULL CHECK (type IN ('warning', 'danger', 'parking')),
  shape_type                     VARCHAR(20) NOT NULL DEFAULT 'circle'
                                  CHECK (shape_type IN ('circle', 'polygon', 'polyline')),
  center_lat                     DOUBLE PRECISION,
  center_lon                     DOUBLE PRECISION,
  radius_meters                  DOUBLE PRECISION,
  geometry                       JSONB,
  corridor_width_meters          DOUBLE PRECISION,
  corridor_danger_margin_meters  DOUBLE PRECISION,
  active                         BOOLEAN DEFAULT TRUE,
  created_at                     TIMESTAMPTZ DEFAULT NOW(),
  -- Garantiza que cada fila tenga los campos correctos según su forma:
  --   circle    → center_lat/center_lon/radius_meters, sin geometry
  --   polygon   → geometry (GeoJSON Polygon), sin campos de círculo
  --   polyline  → geometry (GeoJSON LineString) + corridor_width_meters
  CONSTRAINT geofences_shape_consistency CHECK (
    (shape_type = 'circle'
      AND center_lat IS NOT NULL AND center_lon IS NOT NULL AND radius_meters IS NOT NULL
      AND geometry IS NULL AND corridor_width_meters IS NULL)
    OR
    (shape_type = 'polygon'
      AND geometry IS NOT NULL
      AND center_lat IS NULL AND center_lon IS NULL AND radius_meters IS NULL
      AND corridor_width_meters IS NULL)
    OR
    (shape_type = 'polyline'
      AND geometry IS NOT NULL AND corridor_width_meters IS NOT NULL
      AND center_lat IS NULL AND center_lon IS NULL AND radius_meters IS NULL)
  )
);

-- Auditoría de entradas/salidas de geocercas — las alertas en tiempo
-- real las genera GeofenceAlertService; esta tabla permite
-- consultarlas después (reportes, cruce con el historial de un
-- vehículo).
CREATE TABLE IF NOT EXISTS geofence_events (
  id          BIGSERIAL PRIMARY KEY,
  device_id   VARCHAR(255) NOT NULL,
  geofence_id INTEGER REFERENCES geofences(id) ON DELETE SET NULL,
  event_type  VARCHAR(10) NOT NULL CHECK (event_type IN ('enter', 'exit')),
  severity    VARCHAR(20),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_geofence_events_device_time
  ON geofence_events (device_id, occurred_at DESC);

-- ─────────────────────────────────────────────────────────────
-- Equipo estático (palas, excavadoras, cargadores)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS static_equipment (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  type          VARCHAR(50) NOT NULL,
  latitude      DOUBLE PRECISION NOT NULL,
  longitude     DOUBLE PRECISION NOT NULL,
  swing_radius  DOUBLE PRECISION NOT NULL,
  safety_radius DOUBLE PRECISION NOT NULL,
  status        VARCHAR(20) DEFAULT 'inactive'
                CHECK (status IN ('active_swing', 'active_pause', 'inactive')),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- Turnos de operador — identidad del operador, independiente de la
-- identidad del vehículo/tableta (devices, fija por configuración de
-- kiosco). last_seen_at se actualiza con cada heartbeat mientras el
-- turno sigue abierto, para poder cerrar automáticamente turnos
-- abandonados tras un período de inactividad.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS operator_sessions (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  device_id    VARCHAR(255) NOT NULL REFERENCES devices(unique_id),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at     TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Consulta frecuente: turno activo de un dispositivo (ended_at IS NULL)
CREATE INDEX IF NOT EXISTS idx_operator_sessions_device_active
  ON operator_sessions (device_id) WHERE ended_at IS NULL;

-- Consulta frecuente: reportes por operador o por rango de fechas
CREATE INDEX IF NOT EXISTS idx_operator_sessions_user_time
  ON operator_sessions (user_id, started_at DESC);

-- ─────────────────────────────────────────────────────────────
-- Mapas satelitales/drone importados (TIF+TFW o JPG+JPW → MBTiles).
-- Varios mapas pueden estar activos a la vez, apilados como capas
-- independientes por fecha — ver MapPipelineService.ts y
-- api/routes/maps.routes.ts (/tiles/maps/:mapId/...).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS maps (
  id                     SERIAL PRIMARY KEY,
  name                   VARCHAR(255) NOT NULL,
  status                 VARCHAR(20) NOT NULL DEFAULT 'processing'
                         CHECK (status IN ('processing', 'ready', 'failed')),
  source_crs             VARCHAR(50),
  crs_auto_detected      BOOLEAN DEFAULT FALSE,
  -- {minLat,minLon,maxLat,maxLon} en WGS84 — se calcula tras procesar,
  -- null mientras status='processing' o si status='failed'.
  bounds                 JSONB,
  source_image_filename  VARCHAR(255),
  source_world_filename  VARCHAR(255),
  mbtiles_filename       VARCHAR(255),
  size_mb                DOUBLE PRECISION,
  active                 BOOLEAN DEFAULT FALSE,
  -- Rango de zoom real generado por GDAL — MapLibre lo usa para
  -- declarar el sobre/sub-muestreo automático y que la capa nunca
  -- desaparezca al hacer zoom extremo.
  min_zoom               INTEGER,
  max_zoom               INTEGER,
  error_message          TEXT,
  uploaded_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW()
);
