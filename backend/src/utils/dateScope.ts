// arranque del dia actual (medianoche) en la zona horaria del proceso (America/Mexico_City, TZ
// obligatorio en el backend - ver nota en 001_init.sql) - usado para acotar a Supervisor a "su
// turno" (por ahora, un dia calendario: si otro supervisor entra a media jornada, ve lo mismo del
// dia) en vistas donde Encargado sí puede filtrar libremente por fecha (infracciones, incidentes).
export function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
