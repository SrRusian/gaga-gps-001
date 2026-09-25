-- Requiere PostGIS + TimescaleDB en la imagen de Postgres (timescale/timescaledb-ha, ver docker-compose.yml).
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;

ALTER DATABASE gaga_gps SET timezone TO 'America/Mexico_City';

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- agrupación libre de equipos (reportes futuros por grupo) - greenfield, sin UI todavía
CREATE TABLE IF NOT EXISTS device_groups (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  name VARCHAR(255) NOT NULL,
  speed_limit_kmh DOUBLE PRECISION,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- catalogo global de tipos de vehiculo (largo/ancho reales, metros) - solo admin global lo
-- administra, project_administrator solo asigna un tipo ya existente a sus dispositivos. Usado
-- para dibujar la silueta real del vehiculo en el mapa (ver web/packages/map-core/vehicleMarker.ts)
-- - con RTK a precision centimetrica el circulo de precision GPS ya no basta para saber si el
-- vehiculo (varios metros) iba centrado en su carril/geocerca.
CREATE TABLE IF NOT EXISTS vehicle_types (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  length_meters DOUBLE PRECISION NOT NULL,
  width_meters DOUBLE PRECISION NOT NULL,
  -- opcional - no todos los tipos necesitan limite propio (mismo criterio nullable/sin CHECK que
  -- devices.speed_limit_kmh/geofences.speed_limit_kmh). SpeedAlertService lo combina con el limite
  -- del dispositivo/grupo/geocerca y gana siempre el mas estricto.
  max_speed_kmh DOUBLE PRECISION,
  -- 'transport' = vehiculo de carretera (camion, camioneta, auto) - tiene un estado "estacionado"
  -- real a ~0 km/h. 'machinery' = maquinaria pesada (excavadora, cargador) - trabaja a velocidad de
  -- gateo, donde no se puede distinguir "parado" de "avanzando despacio" con la velocidad GPS. La
  -- categoria decide comportamientos reales (congelado de posicion, aviso anticipado de velocidad),
  -- no es solo una etiqueta - ver stationaryThresholdKmh() en app/packages/operator-ui/localSpeed.ts
  category VARCHAR(20) NOT NULL DEFAULT 'transport' CHECK (category IN ('transport', 'machinery')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  unique_id VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) DEFAULT 'vehicle',
  status VARCHAR(20) DEFAULT 'offline',
  project_id INTEGER REFERENCES projects(id),
  group_id INTEGER REFERENCES device_groups(id),
  vehicle_type_id INTEGER REFERENCES vehicle_types(id) ON DELETE SET NULL,
  last_update TIMESTAMPTZ,
  attributes JSONB DEFAULT '{}',
  speed_limit_kmh DOUBLE PRECISION,
  -- FALSE (default) = puede entrar/salir de una geocerca tipo 'allowed' libremente, sin infraccion,
  -- solo queda el registro en geofence_events. TRUE = debe permanecer dentro, salir genera una
  -- infraccion + alerta al operador. Default FALSE a proposito - un dispositivo existente nunca
  -- empieza a generar infracciones solo porque se dibujo una zona permitida nueva
  restricted_to_allowed_zone BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_devices_project ON devices (project_id);
CREATE INDEX IF NOT EXISTS idx_devices_group ON devices (group_id);
CREATE INDEX IF NOT EXISTS idx_devices_vehicle_type ON devices (vehicle_type_id);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(30) DEFAULT 'operator',
  project_id INTEGER REFERENCES projects(id),
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- ubicacion aproximada capturada una sola vez al iniciar sesion (roles no-operador) - solo si
  -- el navegador dio permiso, nunca bloquea el login
  last_login_lat DOUBLE PRECISION,
  last_login_lon DOUBLE PRECISION,
  last_login_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_users_project ON users (project_id);

CREATE TABLE IF NOT EXISTS positions (
  id BIGSERIAL,
  device_id VARCHAR(255) NOT NULL REFERENCES devices(unique_id),
  project_id INTEGER REFERENCES projects(id),
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  altitude DOUBLE PRECISION DEFAULT 0,
  speed DOUBLE PRECISION DEFAULT 0,
  course DOUBLE PRECISION DEFAULT 0,
  accuracy DOUBLE PRECISION DEFAULT 0,
  battery DOUBLE PRECISION,
  fix_time TIMESTAMPTZ NOT NULL,
  server_time TIMESTAMPTZ DEFAULT NOW(),
  protocol VARCHAR(20) DEFAULT 'osmand',
  valid BOOLEAN DEFAULT TRUE,
  attributes JSONB DEFAULT '{}',
  PRIMARY KEY (id, fix_time)
);

SELECT create_hypertable('positions', 'fix_time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_positions_device_time ON positions (device_id, fix_time DESC);

ALTER TABLE positions SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id',
  timescaledb.compress_orderby = 'fix_time DESC'
);
SELECT add_compression_policy('positions', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('positions', INTERVAL '1 year', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS device_sensor_snapshots (
  id BIGSERIAL,
  device_id VARCHAR(255) NOT NULL REFERENCES devices(unique_id),
  source VARCHAR(20) NOT NULL DEFAULT 'browser',
  data JSONB NOT NULL DEFAULT '{}',
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, captured_at)
);

SELECT create_hypertable('device_sensor_snapshots', 'captured_at', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_sensor_snapshots_device_time
  ON device_sensor_snapshots (device_id, captured_at DESC);

ALTER TABLE device_sensor_snapshots SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id',
  timescaledb.compress_orderby = 'captured_at DESC'
);
SELECT add_compression_policy('device_sensor_snapshots', INTERVAL '1 day', if_not_exists => TRUE);
SELECT add_retention_policy('device_sensor_snapshots', INTERVAL '30 days', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS geofences (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  name VARCHAR(255) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN (
    'warning', 'danger', 'parking', 'forbidden', 'authorized_route', 'allowed', 'discharge', 'maintenance', 'carga'
  )),
  shape_type VARCHAR(20) NOT NULL DEFAULT 'circle'
    CHECK (shape_type IN ('circle', 'polygon', 'polyline')),
  center_lat DOUBLE PRECISION,
  center_lon DOUBLE PRECISION,
  radius_meters DOUBLE PRECISION,
  geometry JSONB,
  corridor_width_meters DOUBLE PRECISION,
  -- ya no se usa en la logica de alertas (la severidad siempre la decide `type`, nunca la
  -- distancia) - se deja la columna sin borrar para no perder datos historicos, simplemente ya no
  -- se lee ni se escribe desde la aplicacion
  corridor_danger_margin_meters DOUBLE PRECISION,
  speed_limit_kmh DOUBLE PRECISION,
  -- solo aplica a shape_type='polygon' - TRUE (default, zona completa) usa ST_Contains como
  -- siempre; FALSE (sin relleno) reutiliza corridor_width_meters como unico umbral de deteccion
  -- de cercania al borde - la severidad la decide `type`, no la distancia
  filled BOOLEAN NOT NULL DEFAULT TRUE,
  -- solo aplica a shape_type='polyline' - TRUE (default, "Ruta autorizada" historico) = debe
  -- quedarse DENTRO del ancho (alerta si se aleja); FALSE = "no tocar" (alerta si se acerca)
  stay_inside BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  geog GEOGRAPHY(GEOMETRY, 4326),
  CONSTRAINT geofences_shape_consistency CHECK (
    (shape_type = 'circle'
      AND center_lat IS NOT NULL AND center_lon IS NOT NULL AND radius_meters IS NOT NULL
      AND geometry IS NULL AND corridor_width_meters IS NULL)
    OR
    (shape_type = 'polygon' AND filled = TRUE
      AND geometry IS NOT NULL
      AND center_lat IS NULL AND center_lon IS NULL AND radius_meters IS NULL
      AND corridor_width_meters IS NULL)
    OR
    (shape_type = 'polygon' AND filled = FALSE
      AND geometry IS NOT NULL AND corridor_width_meters IS NOT NULL
      AND center_lat IS NULL AND center_lon IS NULL AND radius_meters IS NULL)
    OR
    (shape_type = 'polyline'
      AND geometry IS NOT NULL AND corridor_width_meters IS NOT NULL
      AND center_lat IS NULL AND center_lon IS NULL AND radius_meters IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_geofences_geog ON geofences USING GIST (geog);

CREATE TABLE IF NOT EXISTS geofence_events (
  id BIGSERIAL PRIMARY KEY,
  device_id VARCHAR(255) NOT NULL,
  geofence_id INTEGER REFERENCES geofences(id) ON DELETE SET NULL,
  event_type VARCHAR(10) NOT NULL CHECK (event_type IN ('enter', 'exit')),
  severity VARCHAR(20),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_geofence_events_device_time
  ON geofence_events (device_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS static_equipment (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  swing_radius DOUBLE PRECISION NOT NULL,
  safety_radius DOUBLE PRECISION NOT NULL,
  status VARCHAR(20) DEFAULT 'inactive'
    CHECK (status IN ('active_swing', 'active_pause', 'inactive')),
  linked_device_id VARCHAR(255) REFERENCES devices(unique_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_static_equipment_linked_device
  ON static_equipment (linked_device_id) WHERE linked_device_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name VARCHAR(255) NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  supervisor_user_id INTEGER REFERENCES users(id),
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shifts_project ON shifts (project_id);

CREATE TABLE IF NOT EXISTS operator_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  device_id VARCHAR(255) NOT NULL REFERENCES devices(unique_id),
  shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_device_active
  ON operator_sessions (device_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_operator_sessions_user_time
  ON operator_sessions (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_shift_active
  ON operator_sessions (shift_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS maps (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  project_id INTEGER REFERENCES projects(id),
  status VARCHAR(20) NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'ready', 'failed')),
  source_crs VARCHAR(50),
  crs_auto_detected BOOLEAN DEFAULT FALSE,
  bounds JSONB,
  source_image_filename VARCHAR(255),
  source_world_filename VARCHAR(255),
  mbtiles_filename VARCHAR(255),
  size_mb DOUBLE PRECISION,
  active BOOLEAN DEFAULT FALSE,
  min_zoom INTEGER,
  max_zoom INTEGER,
  error_message TEXT,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_maps_project ON maps (project_id);

CREATE TABLE IF NOT EXISTS incident_reports (
  id BIGSERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  device_id VARCHAR(255) NOT NULL REFERENCES devices(unique_id),
  reported_by INTEGER REFERENCES users(id),
  category VARCHAR(30) NOT NULL DEFAULT 'other'
    CHECK (category IN ('obstacle', 'accident', 'traffic', 'other')),
  message TEXT,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  radius_meters DOUBLE PRECISION NOT NULL DEFAULT 120,
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_by INTEGER REFERENCES users(id),
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_incident_reports_project_status
  ON incident_reports (project_id, status);

CREATE TABLE IF NOT EXISTS alert_events (
  id BIGSERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  alert_type VARCHAR(20) NOT NULL
    CHECK (alert_type IN ('geofence', 'signal_lost', 'collision', 'proximity', 'preventive_stop', 'incident', 'equipment_variable', 'speed', 'power_loss', 'restricted_zone')),
  severity VARCHAR(10) NOT NULL CHECK (severity IN ('info', 'warning', 'danger')),
  device_id VARCHAR(255),
  device_id_2 VARCHAR(255),
  message TEXT,
  metadata JSONB,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_alert_events_project_time
  ON alert_events (project_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_events_open
  ON alert_events (alert_type, device_id, device_id_2) WHERE resolved_at IS NULL;

-- historial temporal de a qué proyecto perteneció cada dispositivo/usuario - sobrevive a reasignaciones
-- device_id/user_id SIN REFERENCES a propósito (igual que geofence_events/alert_events) - el historial
-- debe sobrevivir si el dispositivo/usuario se elimina de verdad (force=true), no bloquear ese borrado
CREATE TABLE IF NOT EXISTS device_project_history (
  id BIGSERIAL PRIMARY KEY,
  device_id VARCHAR(255) NOT NULL,
  project_id INTEGER REFERENCES projects(id),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to TIMESTAMPTZ,
  changed_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_device_project_history_device
  ON device_project_history (device_id, valid_from DESC);
CREATE INDEX IF NOT EXISTS idx_device_project_history_open
  ON device_project_history (device_id) WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS user_project_history (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  project_id INTEGER REFERENCES projects(id),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to TIMESTAMPTZ,
  changed_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_user_project_history_user
  ON user_project_history (user_id, valid_from DESC);
CREATE INDEX IF NOT EXISTS idx_user_project_history_open
  ON user_project_history (user_id) WHERE valid_to IS NULL;

-- config editable en runtime desde el panel de Admin, separado de .env (que solo arranca el proceso)
CREATE TABLE IF NOT EXISTS system_settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by INTEGER REFERENCES users(id)
);

-- ── Estructura base: monitoreo de variables críticas de equipos ──────────
-- device_id SIN REFERENCES a propósito (igual que device_project_history) - no debe
-- bloquear force=true; se purga a mano en DeviceRepository.delete(), no vía FK.
CREATE TABLE IF NOT EXISTS equipment_variable_readings (
  id BIGSERIAL,
  device_id VARCHAR(255) NOT NULL,
  variable_key VARCHAR(50) NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  unit VARCHAR(20),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, recorded_at)
);
SELECT create_hypertable('equipment_variable_readings', 'recorded_at', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_equipment_variable_readings_device_var_time
  ON equipment_variable_readings (device_id, variable_key, recorded_at DESC);
ALTER TABLE equipment_variable_readings SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id',
  timescaledb.compress_orderby = 'recorded_at DESC'
);
SELECT add_compression_policy('equipment_variable_readings', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('equipment_variable_readings', INTERVAL '6 months', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS equipment_variable_thresholds (
  id SERIAL PRIMARY KEY,
  device_id VARCHAR(255) REFERENCES devices(unique_id),
  variable_key VARCHAR(50) NOT NULL,
  min_safe DOUBLE PRECISION,
  max_safe DOUBLE PRECISION,
  unit VARCHAR(20),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by INTEGER REFERENCES users(id),
  UNIQUE (device_id, variable_key)
);

-- ── Estructura base: control de producción (solo schema, sin lógica de negocio todavía) ──
-- capa de estado sobre operator_sessions - hoy solo tiene abierto/cerrado, esto agrega el "en qué"
CREATE TABLE IF NOT EXISTS equipment_activity_segments (
  id BIGSERIAL PRIMARY KEY,
  device_id VARCHAR(255) NOT NULL REFERENCES devices(unique_id),
  operator_session_id BIGINT REFERENCES operator_sessions(id),
  activity_type VARCHAR(20) NOT NULL CHECK (activity_type IN ('productive', 'unproductive', 'maintenance')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_equipment_activity_segments_device_time
  ON equipment_activity_segments (device_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_equipment_activity_segments_open
  ON equipment_activity_segments (device_id) WHERE ended_at IS NULL;

-- registros de producción - unidad flexible (m3, toneladas, viajes...) a propósito, no se fija una sola
CREATE TABLE IF NOT EXISTS production_records (
  id BIGSERIAL PRIMARY KEY,
  device_id VARCHAR(255) NOT NULL REFERENCES devices(unique_id),
  project_id INTEGER REFERENCES projects(id),
  shift_id INTEGER REFERENCES shifts(id),
  quantity DOUBLE PRECISION NOT NULL,
  unit VARCHAR(20) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by INTEGER REFERENCES users(id),
  metadata JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_production_records_device_time
  ON production_records (device_id, recorded_at DESC);

-- tarifas para ingreso/costo/pago - vigencia temporal, mismo patrón valid_from/valid_to que
-- device_project_history. NUMERIC (no DOUBLE PRECISION) para evitar redondeo de punto flotante en dinero.
CREATE TABLE IF NOT EXISTS pay_rates (
  id BIGSERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  device_id VARCHAR(255) REFERENCES devices(unique_id),
  user_id INTEGER REFERENCES users(id),
  rate_type VARCHAR(20) NOT NULL CHECK (rate_type IN ('per_unit', 'per_hour')),
  rate_amount NUMERIC(12, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'MXN',
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id)
);

-- historial de releases del APK (actualizacion automatica sin Play Store, ver app-update.routes.ts) -
-- el archivo real vive en el volumen releases/<version_code>.apk, esta tabla es solo el catalogo
CREATE TABLE IF NOT EXISTS app_releases (
  id SERIAL PRIMARY KEY,
  version_code INTEGER UNIQUE NOT NULL,
  version_name VARCHAR(50) NOT NULL,
  sha256 VARCHAR(64) NOT NULL,
  size_bytes BIGINT NOT NULL,
  released_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  released_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_app_releases_version_code ON app_releases (version_code DESC);

-- registro permanente de infracciones reales (exceso de velocidad confirmado 100%+, o vehiculo
-- tocando una geocerca de peligro) - a diferencia de alert_events (estado en vivo que se
-- sobreescribe/resuelve solo), esto nunca se sobreescribe: una fila por episodio real, para que un
-- encargado pueda revisar el historico completo. Los avisos "silenciosos" (proximidad lejana,
-- solo para el operador) nunca generan fila aqui - ver GeofenceAlertService/SpeedAlertService.
CREATE TABLE IF NOT EXISTS infractions (
  id BIGSERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  device_id VARCHAR(255) NOT NULL REFERENCES devices(unique_id),
  -- solo para infraction_type='collision' - el otro vehiculo involucrado (mismo patron que
  -- alert_events.device_id_2, un solo registro por evento en vez de uno duplicado por vehiculo)
  device_id_2 VARCHAR(255) REFERENCES devices(unique_id),
  -- quien operaba el vehiculo en el momento - NULL si no habia turno activo (caso raro)
  operator_session_id BIGINT REFERENCES operator_sessions(id),
  infraction_type VARCHAR(20) NOT NULL CHECK (infraction_type IN ('speed', 'geofence', 'collision')),
  -- 1 (leve) a 10 (grave/choque real) - ver backend/src/utils/infractionSeverity.ts para la formula
  -- por tipo, decidida por el sistema (sin intervencion manual) al momento de crear la fila
  severity SMALLINT NOT NULL DEFAULT 5 CHECK (severity BETWEEN 1 AND 10),
  message TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  metadata JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_infractions_project_time ON infractions (project_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_infractions_device_time ON infractions (device_id, occurred_at DESC);
