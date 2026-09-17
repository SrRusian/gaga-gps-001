// gravedad de una infraccion, escala 1 (leve) a 10 (grave/choque real) - decidida por el sistema al
// momento de crear la fila, sin intervencion manual (pedido explicito: "el sistema inteligente
// calcule esa gravedad"). Formulas deterministicas y documentadas, no until un modelo entrenado -
// mismo criterio ya confirmado con el usuario para el resto del sistema de alertas (ver
// GeofenceAlertService/SpeedAlertService). Constantes ajustables sin tocar la arquitectura, igual
// que WARNING_RATIO/THRESHOLD_1_METERS ya existentes en otros servicios.

function clampSeverity(value: number): number {
  return Math.min(10, Math.max(1, Math.round(value)));
}

// ratio = velocidad/limite en el momento de la infraccion (siempre >= 1, ya cruzo el limite) -
// 1.0 (justo en el limite) = 4, escala hasta 10 al 50% o mas sobre el limite
export function speedInfractionSeverity(ratio: number): number {
  return clampSeverity(4 + (ratio - 1) * 12);
}

// tocar una zona 'danger'/'forbidden' es mas grave que 'warning'/'maintenance' (unico tipo con
// severidad propia que llega a infraccion, 'authorized_route' tambien puede pero es menos grave que
// una zona de peligro real); el tier "urgente" (todavia no toca, ver GeofenceAlertService) resta 2 -
// se acerco demasiado pero no llego a tocar
export function geofenceInfractionSeverity(
  geofenceType: 'danger' | 'forbidden' | 'warning' | 'maintenance' | 'authorized_route' | string,
  proximity: boolean,
): number {
  const base = geofenceType === 'danger' || geofenceType === 'forbidden' ? 8 : 6;
  return clampSeverity(proximity ? base - 2 : base);
}

// colision entre vehiculos - 'critical' (convergiendo muy cerca, todavia sin contacto real) escala
// con la velocidad combinada de ambos (mas velocidad = mas riesgo aunque no haya tocado); 'contact'
// (areas reales ya se tocan) siempre es grave de entrada (9-10), la velocidad solo decide el margen
// entre "choque leve" y "choque a alta velocidad"
export function collisionInfractionSeverity(
  kind: 'critical' | 'contact',
  combinedSpeedKmh: number,
): number {
  if (kind === 'contact') {
    return clampSeverity(9 + combinedSpeedKmh / 40);
  }
  return clampSeverity(5 + combinedSpeedKmh / 20);
}
