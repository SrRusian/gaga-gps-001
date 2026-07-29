-- 003_geofence_shapes.sql
--
-- Extiende las geocercas para soportar múltiples formas, no solo
-- círculos: polígonos (zona autorizada arbitraria) y polilíneas
-- (ruta/corredor autorizado con un ancho definido a cada lado).
--
-- Se usa GeoJSON (columna `geometry` JSONB) como formato interno
-- para polígonos/rutas — es el estándar de facto para geometría en
-- JSON, compatible con QGIS, Leaflet, Mapbox/MapLibre, sin
-- necesidad de PostGIS. Los círculos siguen usando las columnas
-- originales (center_lat/center_lon/radius_meters) sin cambios,
-- para no romper geocercas existentes ni la lógica ya probada de
-- GeofenceAlertService.

ALTER TABLE geofences
  ALTER COLUMN center_lat DROP NOT NULL,
  ALTER COLUMN center_lon DROP NOT NULL,
  ALTER COLUMN radius_meters DROP NOT NULL;

ALTER TABLE geofences
  ADD COLUMN IF NOT EXISTS shape_type VARCHAR(20) NOT NULL DEFAULT 'circle'
    CHECK (shape_type IN ('circle', 'polygon', 'polyline')),
  ADD COLUMN IF NOT EXISTS geometry JSONB,
  ADD COLUMN IF NOT EXISTS corridor_width_meters DOUBLE PRECISION;

-- Garantiza que cada fila tenga los campos correctos según su forma:
--   circle    → center_lat/center_lon/radius_meters, sin geometry
--   polygon   → geometry (GeoJSON Polygon), sin campos de círculo
--   polyline  → geometry (GeoJSON LineString) + corridor_width_meters
ALTER TABLE geofences
  ADD CONSTRAINT geofences_shape_consistency CHECK (
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
  );

-- Registro de entradas/salidas de geocercas — auditoría e historial
-- (RF-ALR-02/03/04 ya generan la alerta en tiempo real; esta tabla
-- permite consultarlas después, por ejemplo para reportes o para
-- cruzar contra el recorrido histórico de un vehículo).
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
