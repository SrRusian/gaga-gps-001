import { useEffect, useState } from 'react';

// Brujula del propio tablet (giroscopio + magnetometro + acelerometro, fusionados por el
// navegador via DeviceOrientationEvent) - SOLO complementa el rumbo GPS cuando el vehiculo esta
// detenido (ver MapView.tsx, resolveOwnCourse). Mientras se mueve, el rumbo GPS sigue mandando sin
// cambio - ya es confiable y evita repetir el problema real ya conocido en este proyecto de usar el
// magnetometro del telefono para decidir algo fino (frente/reversa del chasis, descartado antes por
// interferencia del metal/electronica del vehiculo). Aqui el uso es mucho mas tolerante (orientar
// el mapa/la flecha aproximadamente, no distinguir sentidos opuestos), así que el mismo sensor con
// ruido de +-10 grados sigue siendo util.
export function useDeviceOrientation(): number | null {
  const [heading, setHeading] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    function handle(event: DeviceOrientationEvent) {
      const isAbsolute = (event as DeviceOrientationEvent & { absolute?: boolean }).absolute === true;
      if (!isAbsolute || event.alpha === null) return;
      // alpha crece en sentido antihorario visto desde arriba del dispositivo (convencion del
      // navegador) - se invierte para que coincida con 'course'/bearing de este proyecto (grados
      // en sentido horario desde el norte, igual que GPS/MapLibre). Sin verificar en hardware real
      // todavia - si al apuntar la tableta al norte esto no marca ~0, invertir el signo aqui.
      setHeading((360 - event.alpha) % 360);
    }

    // 'deviceorientationabsolute' (Chrome/WebView Android, no Safari) siempre viene marcado
    // absolute=true - se prefiere sobre 'deviceorientation' (que puede ser relativo al angulo
    // inicial y derivar sin limite, inutil como brujula)
    const eventName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(eventName, handle as EventListener);
    return () => window.removeEventListener(eventName, handle as EventListener);
  }, []);

  return heading;
}
