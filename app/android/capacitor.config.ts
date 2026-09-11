import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.gaga.app',
  appName: 'GAGA App',
  webDir: 'www',
  // 'http' evita el bloqueo de "contenido mixto" del WebView contra servidores de prueba sin TLS
  // (una pagina https no puede llamar a un backend http) - sigue funcionando igual contra un
  // backend real en https el dia que haya uno, ese sentido nunca se bloquea
  server: {
    androidScheme: 'http',
  },
};

export default config;
