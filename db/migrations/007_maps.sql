-- 007_maps.sql
-- Importador de mapas satelitales/drone (TIF+TFW o JPG+JPW → MBTiles).
-- Ver backend/src/services/maps/MapPipelineService.js.

CREATE TABLE IF NOT EXISTS maps (
  id                     SERIAL PRIMARY KEY,
  name                   VARCHAR(255) NOT NULL,
  status                 VARCHAR(20) NOT NULL DEFAULT 'processing'
                         CHECK (status IN ('processing','ready','failed')),
  source_crs             VARCHAR(50),
  crs_auto_detected       BOOLEAN DEFAULT FALSE,
  -- {minLat,minLon,maxLat,maxLon} en WGS84 — se calcula tras procesar,
  -- null mientras status='processing' o si status='failed'.
  bounds                 JSONB,
  source_image_filename  VARCHAR(255),
  source_world_filename  VARCHAR(255),
  mbtiles_filename       VARCHAR(255),
  size_mb                DOUBLE PRECISION,
  -- Solo un mapa puede estar activo (servido en /tiles/alcaraces) —
  -- ver el índice único parcial abajo.
  active                 BOOLEAN DEFAULT FALSE,
  error_message          TEXT,
  uploaded_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW()
);

-- Garantiza a nivel de base de datos que nunca haya dos mapas
-- activos a la vez, incluso ante condiciones de carrera.
CREATE UNIQUE INDEX IF NOT EXISTS idx_maps_single_active ON maps ((active)) WHERE active = TRUE;
