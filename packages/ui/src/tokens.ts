/**
 * tokens.ts
 *
 * Paleta de color compartida — antes cada panel definía la suya por
 * separado. De paso corrige una inconsistencia real encontrada al
 * migrar: Supervisor no tenía un color distinto para "otro
 * vehículo" (usaba el mismo verde que "mi vehículo"), a diferencia
 * de Operador que sí distinguía con #ff6600. Ahora es un solo valor.
 */
export const colors = {
  accent: '#00ff88',
  warning: '#ffaa00',
  warningAlt: '#ffcc00',
  danger: '#ff4444',
  dangerAlt: '#ff2222',
  myVehicle: '#00ff88',
  otherVehicle: '#ff6600',
  bgPrimary: '#0d1117',
  bgSecondary: '#161b22',
  border: '#30363d',
  textMuted: '#8b949e',
} as const;

export type ColorToken = keyof typeof colors;
