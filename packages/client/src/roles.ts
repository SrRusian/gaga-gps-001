const ROLE_PATH: Record<string, string> = {
  admin: 'administrator',
  project_administrator: 'project-admin',
  project_manager: 'manager',
  project_supervisor: 'supervisor',
  operator: 'operator',
};

export function resolveRolePath(role: string): string {
  return ROLE_PATH[role] ?? role;
}

const ROLE_LABEL: Record<string, string> = {
  operator: 'Operador',
  project_supervisor: 'Supervisor de Proyecto',
  project_manager: 'Encargado de Proyecto',
  project_administrator: 'Administrador de Proyecto',
  admin: 'Administrador',
};

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

export function roleEntries(): [string, string][] {
  return Object.entries(ROLE_LABEL);
}
