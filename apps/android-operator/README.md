# GAGA Operador (Android)

App nativa Android que unifica en un solo APK las 3 apps que hoy usa la tableta:

1. **Operador GAGA** (mapa, alertas, turnos, incidentes) - el mismo código web que ya corre en el navegador, sin fork. Vive en `apps/web-app`, esta app solo lo empaqueta con Capacitor.
2. **Traccar Client** - envío de posición configurable a uno o varios servidores por el protocolo OsmAnd (el mismo que usa Traccar Client de verdad), con lista de servidores administrable desde la propia app (agregar/quitar/activar).
3. **GNSS Master** - conexión al receptor RTK por **USB**, cliente NTRIP (corrección en tiempo real contra un caster) y alimentación del fix corregido al sistema como *mock location*, para que tanto el mapa del Operador como el envío de posición usen automáticamente la posición RTK en vez del GPS interno del tablet.

Todo esto se controla desde una pantalla nueva ("Integraciones") dentro del propio panel de Operador, visible solo cuando la app corre empacada como app nativa (no aparece en el navegador normal).

## Qué ya está construido

- Proyecto Capacitor + Android generado con la herramienta oficial (`npx cap add android`), no escrito a mano - reduce el riesgo de un Gradle mal armado.
- `TraccarSenderPlugin`/`TraccarSenderService` (Kotlin) - servicio en primer plano, protocolo OsmAnd, lista de servidores persistida, notificación obligatoria de Android mientras corre.
- `RtkNtripPlugin` (Kotlin) - USB serial real (`usb-serial-for-android`, soporta FTDI/CP210x/CH340/PL2303), parser NMEA (GGA/RMC) real, cliente NTRIP v1/v2 real (handshake HTTP + heartbeat GGA + stream RTCM), y el puente a `LocationManager.setTestProviderLocation` (mock location).
- `packages/android-bridge` - la interfaz TypeScript hacia esos dos plugins, consumida por `apps/web-app`.
- `DeviceIntegrationSettings.tsx` - la pantalla de configuración dentro del Operador (servidores, USB, NTRIP, estado del fix en vivo).
- `npm run cap:sync` (dentro de esta carpeta) ya se probó de punta a punta en este entorno: compila `apps/web-app`, copia el `dist/` a `www/`, y corre `cap sync android` - **sin errores**.

## Qué falta y por qué no lo hice aquí

No hay SDK de Android, Gradle nativo ni `adb` instalados en este entorno - solo Node/npm. Pude generar y sincronizar el proyecto Capacitor (eso es JavaScript puro), pero **nunca compilé el APK ni probé nada contra hardware real** (ni el receptor RTK, ni el caster NTRIP, ni el mock-location). El código Kotlin está escrito con cuidado y sigue la documentación oficial de cada pieza (Capacitor plugin API, `usb-serial-for-android`, NTRIP v1/v2, `LocationManager`), pero la primera compilación real en Android Studio es también la primera vez que un compilador de verdad lo revisa - trátalo como una v1 sólida, no como código ya probado en campo.

## Pasos en Android Studio

1. `File > Open` → selecciona `apps/android-operator/android` (no la raíz del repo).
2. Deja que Gradle sincronice (primera vez tarda, descarga AGP, Capacitor Android, Kotlin y `usb-serial-for-android` vía JitPack - necesita internet).
3. Conecta la tableta por USB con "Depuración USB" activada, o usa "Depuración inalámbrica" si el puerto USB ya está ocupado por el receptor RTK (ver más abajo).
4. `Run` para probar, o `Build > Generate Signed App Bundle / APK` para el instalable final (crea un keystore nuevo la primera vez y guárdalo - lo vas a necesitar para cada actualización).

### El puerto USB se comparte con el receptor RTK

La mayoría de las tabletas solo tienen un puerto USB-C. Si lo usas para el cable de depuración no queda libre para el receptor RTK. Para desarrollar cómodo: activa "Depuración inalámbrica" en Opciones de desarrollador (Android 11+) y deja el puerto físico libre para el receptor.

### Paso manual obligatorio: mock location

Android bloquea por diseño que cualquier app finja tu ubicación, a menos que la elijas explícitamente. Después de instalar la app una vez:

`Ajustes > Opciones de desarrollador > Seleccionar app de ubicación falsa` → elige **GAGA Operador**.

Sin este paso, el botón "Activar ubicación simulada" de la pantalla de Integraciones falla con un mensaje claro (ya está manejado en el código, no truena la app) explicando este mismo paso.

## Cómo se actualiza el contenido web dentro del APK

Cada vez que cambie algo en `apps/web-app` y quieras que el APK lo lleve:

```bash
cd apps/android-operator
npm run cap:sync
```

Esto recompila `apps/web-app`, copia el resultado a `www/`, y sincroniza `android/`. Después, en Android Studio, vuelve a compilar/instalar.

## Limitaciones conocidas (v1, honestas)

- El envío de posición (Traccar) y el RTK/NTRIP corren mientras la app está viva - no son servicios 100% independientes de la actividad como sí lo es, por ejemplo, el envío de posición de Traccar Client real cuando la pantalla se apaga por mucho tiempo. Para el caso de uso real (tableta con pantalla encendida en la máquina durante el turno) no debería notarse, pero si algún día se reporta que se corta al apagar pantalla, ese es el punto a revisar primero.
- El envío de posición no guarda una cola offline todavía (Traccar Client real sí - si no hay red, encola los puntos y los reintenta después; esta versión simplemente descarta el intento fallido y sigue con el siguiente). Se puede agregar sin mucho esfuerzo si hace falta.
- Sin pruebas de campo todavía contra un receptor RTK real ni un caster NTRIP real - la primera vez que se pruebe con hardware real es la prueba de verdad de este código.
