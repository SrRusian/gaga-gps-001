import { useEffect, useState } from 'react';

function formatClock(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// reloj del panel superior - se alinea al segundo exacto en que cambia el minuto y de ahi en
// adelante se actualiza una vez por minuto (nunca cada segundo) - visible siempre sin gastar
// bateria en renders que nadie nota (sin segundos en pantalla, no hace falta mas frecuencia)
export function useClock(): string {
  const [label, setLabel] = useState(() => formatClock(new Date()));

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const msToNextMinute = 60000 - (Date.now() % 60000);
    const timeoutId = setTimeout(() => {
      setLabel(formatClock(new Date()));
      intervalId = setInterval(() => setLabel(formatClock(new Date())), 60000);
    }, msToNextMinute);
    return () => {
      clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
    };
  }, []);

  return label;
}
