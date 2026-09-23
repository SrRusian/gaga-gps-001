export const colors = {
  accent: '#008cff',
  warning: '#f0a83c',
  warningAlt: '#f5b95c',
  danger: '#e5484d',
  dangerAlt: '#c93b40',
  info: '#008cff',
  myVehicle: '#008cff',
  otherVehicle: '#8b95a1',
  // mismo valor que danger - vehículo desconectado/sin señal reciente en el mapa
  offlineVehicle: '#e5484d',
  // anillo de selección en el mapa - web/packages/map-core duplica este valor a propósito (no depende de este paquete)
  selected: '#ffd23f',
  bgPrimary: '#0b0d10',
  bgSecondary: '#14171c',
  border: '#262b33',
  textMuted: '#7d93b8',
} as const;

export type ColorToken = keyof typeof colors;
