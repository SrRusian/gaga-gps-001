// Sistema de prioridad de alertas del Operador - pedido explicito: multiples condiciones (servidor
// desconectado, RTK desconectado, sin red, geocerca de peligro, exceso de velocidad, zona
// restringida, colision/proximidad) deben poder convivir visibles a la vez SIN saturar la pantalla,
// pero solo UNA suena en cada momento - la de mayor prioridad. Si esa se resuelve, la siguiente en
// la fila retoma el sonido (o "baja de nivel" si ya no queda ninguna urgente).
//
// Puramente funciones puras, sin estado propio - cada fuente (useOperatorSocket, useLocalAlerts, el
// estado de RTK/red) computa su propia entrada 0-o-1 en cada render, OperatorApp.tsx arma el
// arreglo completo y lo ordena aqui.

export type AlertSeverity = 'warning' | 'danger';

export interface StackedAlert {
  // identidad estable de la FUENTE (nunca del contenido) - se usa para saber si "la alerta que
  // suena ahora" sigue siendo la misma entre un render y el siguiente, sin comparar mensajes
  id:
    | 'server'
    | 'connectivity'
    | 'rtk'
    | 'restricted_zone'
    | 'geofence'
    | 'speed';
  severity: AlertSeverity;
  message: string;
  // si debe repetirse en bucle mientras siga activa (peligro sostenido) o sonar una sola vez
  // (aviso puntual) - mismo parametro que ya acepta playDangerSound(loop)
  loop: boolean;
  // casi siempre true - false solo para el caso puntual de un aviso visual sin beep (ej.
  // equipment:approach_outer, el radio exterior de equipo estatico: se ve el banner amber pero no
  // suena, a diferencia de approach_inner que si suena - distincion ya existente antes de este
  // rediseño, preservada aqui en vez de perderse al centralizar el sonido)
  sound: boolean;
}

// mayor = gana el sonido y el primer lugar visual. Grupos, de mas a menos urgente:
// 1) peligro real ya reportado por el servidor (colision/contacto, parada preventiva, equipo,
//    incidente cercano) - ve a TODA la flota, algo que la tableta sola no puede saber
// 2) infracciones reales que la propia tableta ya decidio (zona restringida > geocerca > velocidad,
//    mismo orden que ya tenia pickAlert antes de este rediseño)
// 3) sin conexion prolongada (nivel 2) - ya no se puede seguir operando a ciegas
// 4) avisos "warning" de las mismas fuentes de arriba, con menor urgencia
// 5) sin conexion, primer aviso (nivel 1) - reduzca velocidad, todavia hay margen
// 6) RTK desconectado - degradado (sigue habiendo GPS), nunca al punto de exigir detenerse
const PRIORITY: Record<StackedAlert['id'], Record<AlertSeverity, number>> = {
  server: { danger: 90, warning: 60 },
  restricted_zone: { danger: 85, warning: 85 },
  geofence: { danger: 80, warning: 55 },
  speed: { danger: 75, warning: 50 },
  connectivity: { danger: 70, warning: 45 },
  rtk: { danger: 30, warning: 30 },
};

export function alertPriority(alert: StackedAlert): number {
  return PRIORITY[alert.id][alert.severity];
}

// de mayor a menor prioridad - estable (Array.prototype.sort en V8/JSC ya es estable, pero no
// dependemos de eso: en un empate real no importa el orden entre las dos)
export function sortAlertStack(alerts: StackedAlert[]): StackedAlert[] {
  return [...alerts].sort((a, b) => alertPriority(b) - alertPriority(a));
}

// la unica que debe sonar - la de mayor prioridad ENTRE LAS SONORAS del arreglo YA ORDENADO
// (sortAlertStack), o null si no hay ninguna. Una entrada visible con sound:false (ver StackedAlert)
// sigue mostrandose en la pantalla, solo queda fuera de esta eleccion - nunca silencia a la
// siguiente entrada sonora de menor prioridad, como si no estuviera
export function topSoundAlert(sortedAlerts: StackedAlert[]): StackedAlert | null {
  return sortedAlerts.find((a) => a.sound) ?? null;
}
