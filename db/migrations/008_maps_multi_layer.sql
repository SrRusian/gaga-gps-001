-- 008_maps_multi_layer.sql
-- Permite varios mapas activos a la vez, apilados como capas
-- independientes (antes solo uno podía estar activo, servido en un
-- archivo fijo alcaraces.mbtiles). Ver
-- backend/src/api/routes/maps.routes.js (/tiles/maps/:mapId/...).

DROP INDEX IF EXISTS idx_maps_single_active;

-- Rango de zoom real generado por GDAL — antes solo se usaba
-- internamente en el pipeline; ahora el frontend lo necesita para
-- declarar el sobre/sub-muestreo automático de MapLibre y que la
-- capa nunca desaparezca al hacer zoom extremo.
ALTER TABLE maps ADD COLUMN IF NOT EXISTS min_zoom INTEGER;
ALTER TABLE maps ADD COLUMN IF NOT EXISTS max_zoom INTEGER;
