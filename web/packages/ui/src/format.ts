export function formatAccuracy(meters: number | null | undefined): string {
  if (meters === null || meters === undefined || Number.isNaN(meters)) return '--';
  if (meters < 1) return `±${Math.round(meters * 100)} cm`;
  return `±${meters.toFixed(1)} m`;
}
