/**
 * roles.ts
 *
 * `admin`/`supervisor`/`operator` son a la vez el nombre del rol y la
 * ruta de su panel. Los roles de proyecto reutilizan el MISMO
 * componente que Admin/Supervisor con menos alcance (nunca una copia
 * propia) pero sí tienen su propia ruta - puramente por identidad/
 * profesionalismo de URL (que se note con qué rol entraste), no por
 * seguridad real: la única puerta de verdad es `ProtectedRoute` +
 * la validación de JWT/rol en cada endpoint del backend, no el string
 * de la URL. Este mapeo es el único lugar donde "rol" y "ruta" se
 * desacoplan - `App.tsx` monta el mismo `<AdminApp />`/`<SupervisorApp />`
 * en ambas rutas de cada par, así que un cambio a ese componente
 * afecta a los dos roles por igual, nunca hay que tocar dos copias.
 */
const ROLE_PATH: Record<string, string> = {
  admin: 'admin',
  project_manager: 'encargado',
  supervisor: 'supervisor',
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
  project_supervisor: 'Supervisor',
  project_manager: 'Encargado de Proyecto',
  admin: 'Admin',
  supervisor: 'Supervisor',
};

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

/** Pares [valor, etiqueta] para poblar un `<select>` de rol - `ROLE_LABEL` en sí se queda privado, todo consumidor pasa por una función. */
export function roleEntries(): [string, string][] {
  return Object.entries(ROLE_LABEL);
}
