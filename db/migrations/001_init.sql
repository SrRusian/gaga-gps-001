-- 001_init.sql
-- Schema inicial del sistema GPS propio GAGA-GPS-001
-- Reemplaza las tablas tc_devices / tc_positions de Traccar.
-- Requiere las extensiones PostGIS y TimescaleDB en la imagen de Postgres.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ─────────────────────────────────────────────────────────────
-- Dispositivos (reemplaza tc_devices de Traccar)
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
-- Posiciones (reemplaza tc_positions de Traccar)
-- TimescaleDB hypertable particionada por tiempo (fix_time)
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

-- ─────────────────────────────────────────────────────────────
-- Geocercas
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS geofences (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  type          VARCHAR(20) NOT NULL CHECK (type IN ('warning','danger')),
  center_lat    DOUBLE PRECISION NOT NULL,
  center_lon    DOUBLE PRECISION NOT NULL,
  radius_meters DOUBLE PRECISION NOT NULL,
  active        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- Equipos estáticos (palas, excavadoras, cargadores)
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
                CHECK (status IN ('active_swing','active_pause','inactive')),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- Usuarios (operadores, supervisores, admins)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) UNIQUE NOT NULL,
  password   VARCHAR(255) NOT NULL,
  name       VARCHAR(255) NOT NULL,
  role       VARCHAR(20) DEFAULT 'operator'
             CHECK (role IN ('operator','supervisor','admin')),
  active     BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
