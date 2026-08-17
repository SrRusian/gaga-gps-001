/**
 * format.ts
 *
 * Formato de precisión GPS/RTK - bajo 1m se muestra en centímetros
 * en vez de redondear a "±0 m". Con GPS puro esto casi nunca importa
 * (rara vez baja de 1m), pero con RTK en FIX real (objetivo: unos
 * pocos centímetros) redondear a metros enteros esconde exactamente
 * la mejora que se busca medir.
 */
export function formatAccuracy(meters: number | null | undefined): string {
  if (meters === null || meters === undefined || Number.isNaN(meters)) return '--';
  if (meters < 1) return `±${Math.round(meters * 100)} cm`;
  return `±${meters.toFixed(1)} m`;
}
