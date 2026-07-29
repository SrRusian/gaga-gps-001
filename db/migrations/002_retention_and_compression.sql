-- 002_retention_and_compression.sql
--
-- Política de compresión y retención para la hypertable `positions`.
--
-- Contexto: las tabletas pueden reportar posición cada 1 segundo,
-- lo que puede generar cientos de millones de filas al año con
-- flotas grandes. TimescaleDB permite comprimir datos de series de
-- tiempo antiguos (10-20x menos espacio) sin afectar las consultas,
-- y purgar automáticamente lo que ya no se necesita conservar.
--
-- Diseño:
--   - Los últimos 7 días quedan sin comprimir — son los que más se
--     consultan (historial reciente, reportes, replay), y así se
--     evita el pequeño costo de descompresión en lecturas frecuentes.
--   - A partir de 7 días, TimescaleDB comprime automáticamente los
--     chunks en segundo plano (job programado, no bloquea escrituras).
--   - A partir de 1 año, TimescaleDB elimina automáticamente los
--     chunks completos (purga real, libera espacio en disco).
--
-- Ajustar los intervalos según política de retención de la operación
-- (auditorías de seguridad, regulaciones locales, etc.).

-- Habilitar compresión en la hypertable — se agrupan filas por
-- device_id y se ordenan por fix_time para máxima eficiencia de
-- compresión (los valores de un mismo vehículo cambian poco a poco).
ALTER TABLE positions SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id',
  timescaledb.compress_orderby = 'fix_time DESC'
);

-- Comprimir automáticamente chunks con datos de más de 7 días
SELECT add_compression_policy('positions', INTERVAL '7 days', if_not_exists => TRUE);

-- Eliminar automáticamente chunks con datos de más de 1 año
SELECT add_retention_policy('positions', INTERVAL '1 year', if_not_exists => TRUE);
