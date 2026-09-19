import { useCallback, useEffect, useRef } from 'react';

// Un solo AudioContext reutilizado para toda la sesion. Antes se creaba uno NUEVO en cada aviso y
// nunca se cerraba: en un turno con varias alertas se acumulaban decenas, y el navegador corta a
// los ~6 por pagina - a partir de ahi `new AudioContext()` truena y el operador se queda sin NINGUN
// sonido de alerta, justo cuando mas falta hace. Ademas stopSound() solo limpiaba el intervalo y
// dejaba vivo el oscilador que ya estaba sonando: bug real de campo del 19 sep, el pitido de una
// alerta de desconexion siguio sonando todo el viaje aunque en pantalla ya no hubiera nada.
export function useAlertSound() {
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  // osciladores sonando ahora mismo - stopSound los corta de verdad, no solo deja de programar mas
  const liveRef = useRef<OscillatorNode[]>([]);

  const getContext = useCallback((): AudioContext | null => {
    try {
      if (!ctxRef.current) ctxRef.current = new AudioContext();
      // el navegador suspende el contexto al pasar la app a segundo plano - sin esto, al volver
      // no vuelve a sonar nada aunque la alerta siga activa
      if (ctxRef.current.state === 'suspended') void ctxRef.current.resume();
      return ctxRef.current;
    } catch {
      return null;
    }
  }, []);

  const stopSound = useCallback(() => {
    if (loopRef.current) {
      clearInterval(loopRef.current);
      loopRef.current = null;
    }
    liveRef.current.forEach((oscillator) => {
      try {
        oscillator.stop();
      } catch {
        // ya se detuvo solo - stop() sobre un oscilador terminado lanza, y no es un problema
      }
    });
    liveRef.current = [];
  }, []);

  const beep = useCallback(
    (frequency: number, durationSeconds: number) => {
      const ctx = getContext();
      if (!ctx) return;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationSeconds);
      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + durationSeconds);
      liveRef.current.push(oscillator);
      oscillator.onended = () => {
        liveRef.current = liveRef.current.filter((o) => o !== oscillator);
      };
    },
    [getContext],
  );

  const playWarningSound = useCallback(() => {
    stopSound();
    beep(880, 0.5);
  }, [beep, stopSound]);

  const playDangerSound = useCallback(
    (loop?: boolean) => {
      stopSound();
      beep(1200, 0.3);
      if (loop) loopRef.current = setInterval(() => beep(1200, 0.3), 600);
    },
    [beep, stopSound],
  );

  // red de seguridad: si el componente se desmonta con una alerta sonando, el pitido no debe
  // sobrevivirle
  useEffect(() => {
    return () => {
      stopSound();
      ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
    };
  }, [stopSound]);

  return { playWarningSound, playDangerSound, stopSound };
}
