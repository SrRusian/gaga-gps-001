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

CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  unique_id VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) DEFAULT 'vehicle',
  status VARCHAR(20) DEFAULT 'offline',
  project_id INTEGER REFERENCES projects(id),
  last_update TIMESTAMPTZ,
  attributes JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_devices_project ON devices (project_id);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'operator',
  project_id INTEGER REFERENCES projects(id),
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_project ON users (project_id);

CREATE TABLE IF NOT EXISTS positions (
  id BIGSERIAL,
  device_id VARCHAR(255) NOT NULL REFERENCES devices(unique_id),
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
  type VARCHAR(20) NOT NULL CHECK (type IN ('warning', 'danger', 'parking')),
  shape_type VARCHAR(20) NOT NULL DEFAULT 'circle'
    CHECK (shape_type IN ('circle', 'polygon', 'polyline')),
  center_lat DOUBLE PRECISION,
  center_lon DOUBLE PRECISION,
  radius_meters DOUBLE PRECISION,
  geometry JSONB,
  corridor_width_meters DOUBLE PRECISION,
  corridor_danger_margin_meters DOUBLE PRECISION,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  geog GEOGRAPHY(GEOMETRY, 4326),
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
    CHECK (alert_type IN ('geofence', 'signal_lost', 'collision', 'proximity', 'preventive_stop', 'incident')),
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
