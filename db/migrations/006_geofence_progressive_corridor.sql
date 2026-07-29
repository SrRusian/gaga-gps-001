-- 006_geofence_progressive_corridor.sql
--
-- Segundo margen para rutas/corredores autorizados: dentro de
-- corridor_width_meters no hay alerta; entre corridor_width_meters
-- y corridor_width_meters + corridor_danger_margin_meters se
-- dispara advertencia; más allá, peligro (salió de la ruta).

ALTER TABLE geofences
  ADD COLUMN IF NOT EXISTS corridor_danger_margin_meters DOUBLE PRECISION;
