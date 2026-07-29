-- 005_operator_session_heartbeat.sql
--
-- Añade seguimiento de actividad a los turnos de operador para
-- poder descartar automáticamente sesiones abandonadas (tableta
-- perdida, app cerrada sin cerrar turno, etc.) tras un período de
-- inactividad — sin forzar re-login constante durante uso normal.

ALTER TABLE operator_sessions
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
