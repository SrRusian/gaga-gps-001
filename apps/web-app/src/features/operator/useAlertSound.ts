import { useCallback, useRef } from 'react';

export function useAlertSound() {
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopSound = useCallback(() => {
    if (loopRef.current) {
      clearInterval(loopRef.current);
      loopRef.current = null;
    }
  }, []);

  const playWarningSound = useCallback(() => {
    stopSound();
    const ctx = new AudioContext();
    const oscillator = ctx.createOscillator();
    oscillator.connect(ctx.destination);
    oscillator.frequency.value = 880;
    oscillator.start();
    setTimeout(() => oscillator.stop(), 500);
  }, [stopSound]);

  const playDangerSound = useCallback(
    (loop?: boolean) => {
      stopSound();
      const ctx = new AudioContext();

      const playBeep = () => {
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);
        oscillator.frequency.value = 1200;
        gainNode.gain.setValueAtTime(1, ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        oscillator.start(ctx.currentTime);
        oscillator.stop(ctx.currentTime + 0.3);
      };

      playBeep();
      if (loop) {
        loopRef.current = setInterval(playBeep, 600);
      }
    },
    [stopSound],
  );

  return { playWarningSound, playDangerSound, stopSound };
}
