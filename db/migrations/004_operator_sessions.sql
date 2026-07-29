-- 004_operator_sessions.sql
--
-- Registro de turnos operador-vehículo, independiente de la
-- identidad del dispositivo GPS y del historial de posiciones.
--
-- Diseño: el vehículo/tableta se identifica de forma fija por
-- configuración de kiosco (ver ui-operator, parámetro ?device= en
-- la URL) — no cambia con quién esté operando. El operador inicia
-- sesión por separado (reutilizando el login de `users`) al
-- comenzar su turno; puede hacerlo en cualquier máquina distinta
-- en turnos distintos. Esto permite reportar tanto "¿quién operó
-- este vehículo y cuándo?" como "¿cuántas horas trabajó esta
-- persona, en qué máquinas?", sin acoplar ambos conceptos.

CREATE TABLE IF NOT EXISTS operator_sessions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  device_id  VARCHAR(255) NOT NULL REFERENCES devices(unique_id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at   TIMESTAMPTZ
);

-- Consulta frecuente: turno activo de un dispositivo (ended_at IS NULL)
CREATE INDEX IF NOT EXISTS idx_operator_sessions_device_active
  ON operator_sessions (device_id) WHERE ended_at IS NULL;

-- Consulta frecuente: reportes por operador o por rango de fechas
CREATE INDEX IF NOT EXISTS idx_operator_sessions_user_time
  ON operator_sessions (user_id, started_at DESC);
