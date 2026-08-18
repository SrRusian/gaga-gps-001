/**
 * roles.ts
 *
 * Solo 4 roles reales en todo el sistema: `admin`, `project_manager`,
 * `project_supervisor`, `operator` - el antiguo `supervisor` "clásico"
 * (sin proyecto, de antes de la Fase A de multi-tenencia) se eliminó
 * por completo el 2026-08-17 - cero cuentas lo usaban ya, y tenerlo
 * vivo en `ROLE_PATH`/`ROLE_LABEL` producía una entrada duplicada
 * "Supervisor" en el `<select>` de rol (dos valores de rol distintos,
 * mismo texto mostrado - bug real reportado en campo). Si hace falta
 * reintroducir un supervisor sin proyecto en el futuro, es una
 * decisión de producto nueva, no un revert de este cambio.
 *
 * Cada rol tiene su propia ruta - puramente por identidad/
 * profesionalismo de URL (que se note con qué rol entraste), no por
 * seguridad real: la única puerta de verdad es `ProtectedRoute` +
 * la validación de JWT/rol en cada endpoint del backend, no el string
 * de la URL. `project_manager`/`project_supervisor` reutilizan el
 * MISMO componente que Admin/Supervisor con menos alcance (nunca una
 * copia propia) - `App.tsx` monta el mismo `<AdminApp />`/
 * `<SupervisorApp />` en ambas rutas de cada par, así que un cambio a
 * ese componente afecta a los dos roles por igual, nunca hay que
 * tocar dos copias.
 */
const ROLE_PATH: Record<string, string> = {
  admin: 'administrator',
  project_manager: 'manager',
  project_supervisor: 'supervisor',
  operator: 'operator',
};

export function resolveRolePath(role: string): string {
  return ROLE_PATH[role] ?? role;
}

/**
 * Etiqueta legible del rol - antes vivía duplicada en
 * `DashboardSection.tsx` (Admin) sin que `SupervisorApp.tsx` la
 * reutilizara, así que el header de Supervisor mostraba el nombre de
 * usuario solo, sin rol, con un tratamiento visual distinto al de
 * Admin. Un solo lugar para las dos - mismo criterio que `ROLE_PATH`
 * arriba.
 */
const ROLE_LABEL: Record<string, string> = {
  operator: 'Operador',
  project_supervisor: 'Supervisor de Proyecto',
  project_manager: 'Encargado de Proyecto',
  admin: 'Administrador',
};

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

/** Pares [valor, etiqueta] para poblar un `<select>` de rol - `ROLE_LABEL` en sí se queda privado, todo consumidor pasa por una función. */
export function roleEntries(): [string, string][] {
  return Object.entries(ROLE_LABEL);
}
