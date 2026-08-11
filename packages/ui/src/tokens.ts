/**
 * tokens.ts
 *
 * Paleta de color compartida — antes cada panel definía la suya por
 * separado. De paso corrige una inconsistencia real encontrada al
 * migrar: Supervisor no tenía un color distinto para "otro
 * vehículo" (usaba el mismo verde que "mi vehículo"), a diferencia
 * de Operador que sí distinguía con #ff6600. Ahora es un solo valor.
 *
 * Paleta profesional (oscura, neutra, sin neón) — mismo criterio que
 * ya se aplicó al panel de Supervisor, ahora es la base compartida
 * también para Operador y para los marcadores del mapa en ambos.
 */
export const colors = {
  accent: '#4f8ff0',
  warning: '#f0a83c',
  warningAlt: '#f5b95c',
  danger: '#e5484d',
  dangerAlt: '#c93b40',
  info: '#4f8ff0',
  myVehicle: '#4f8ff0',
  otherVehicle: '#8b95a1',
  bgPrimary: '#0b0d10',
  bgSecondary: '#14171c',
  border: '#262b33',
  textMuted: '#8b949e',
} as const;

export type ColorToken = keyof typeof colors;
