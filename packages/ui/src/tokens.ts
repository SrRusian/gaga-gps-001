export const colors = {
  accent: '#4f8ff0',
  warning: '#f0a83c',
  warningAlt: '#f5b95c',
  danger: '#e5484d',
  dangerAlt: '#c93b40',
  info: '#4f8ff0',
  myVehicle: '#4f8ff0',
  otherVehicle: '#8b95a1',
  // mismo valor que danger - vehículo desconectado/sin señal reciente en el mapa
  offlineVehicle: '#e5484d',
  // anillo de selección en el mapa - packages/map-core duplica este valor a propósito (no depende de este paquete)
  selected: '#ffd23f',
  bgPrimary: '#0b0d10',
  bgSecondary: '#14171c',
  border: '#262b33',
  textMuted: '#8b949e',
} as const;

export type ColorToken = keyof typeof colors;
