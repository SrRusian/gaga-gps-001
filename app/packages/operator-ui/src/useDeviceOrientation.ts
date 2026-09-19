import { Power } from '@gaga-gps/android-bridge';
import { useEffect, useState } from 'react';

// Brujula del propio tablet (giroscopio + magnetometro + acelerometro, fusionados por el
// navegador via DeviceOrientationEvent) - SOLO complementa el rumbo GPS cuando el vehiculo esta
// detenido (ver MapView.tsx, resolveOwnCourse). Mientras se mueve, el rumbo GPS sigue mandando sin
// cambio - ya es confiable y evita repetir el problema real ya conocido en este proyecto de usar el
// magnetometro del telefono para decidir algo fino (frente/reversa del chasis, descartado antes por
// interferencia del metal/electronica del vehiculo). Aqui el uso es mucho mas tolerante (orientar
// el mapa/la flecha aproximadamente, no distinguir sentidos opuestos), así que el mismo sensor con
// ruido de +-10 grados sigue siendo util.
// cuanto esta girada la pantalla respecto a la orientacion natural del dispositivo. 0 si el sistema
// no lo expone - ante la duda no se corrige nada, que es el comportamiento de antes.
function screenAngle(): number {
  if (typeof window === 'undefined') return 0;
  const angle = window.screen?.orientation?.angle;
  return typeof angle === 'number' ? angle : 0;
}

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
      //
      // alpha SIEMPRE se mide contra la orientacion NATURAL del dispositivo, no contra como se ve
      // la pantalla: el navegador no lo remapea al rotar (esto corrige la suposicion contraria que
      // estaba documentada antes, sin verificar). La tableta va montada acostada, girada 90 grados,
      // asi que el "arriba" que ve el operador es otro eje del dispositivo - screen.orientation
      // .angle es exactamente ese giro. Si la orientacion natural de la tableta YA es horizontal,
      // el angulo vale 0 y esto no cambia nada: solo suma cuando de verdad hace falta.
      setHeading((360 - event.alpha + screenAngle()) % 360);
    }

    // 'deviceorientationabsolute' (Chrome/WebView Android, no Safari) siempre viene marcado
    // absolute=true - se prefiere sobre 'deviceorientation' (que puede ser relativo al angulo
    // inicial y derivar sin limite, inutil como brujula)
    const eventName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';

    let listening = false;
    function start() {
      if (listening) return;
      listening = true;
      window.addEventListener(eventName, handle as EventListener);
    }
    // durante la suspension por perdida de corriente hay que consumir lo minimo posible (pedido
    // explicito): el magnetometro/giroscopio se sueltan igual que ya hace useDeviceGeolocation con
    // el GPS. Sin esto seguian registrados con la pantalla apagada y el vehiculo apagado.
    function stop() {
      if (!listening) return;
      listening = false;
      window.removeEventListener(eventName, handle as EventListener);
      setHeading(null);
    }

    start();
    Power.getStatus().then((status) => {
      if (status.suspended) stop();
    });
    const powerListenerPromise = Power.addListener('powerStatus', (status) => {
      if (status.suspended) stop();
      else start();
    });

    return () => {
      stop();
      powerListenerPromise.then((h) => h.remove());
    };
  }, []);

  return heading;
}
