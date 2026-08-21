# GAGA Operador (Android)

App nativa Android que unifica en un solo APK las 3 apps que hoy usa la tableta:

1. **Operador GAGA** (mapa, alertas, turnos, incidentes) - el mismo código web que ya corre en el navegador, sin fork. Vive en `apps/web-app`, esta app solo lo empaqueta con Capacitor.
2. **Traccar Client** - envío de posición por protocolo OsmAnd, deliberadamente simple: GPS y buffer sin conexión siempre al máximo (no hay ajustes que solo serían "peor que el default" - ver filosofía abajo), con intervalo editable y envío manual/bitácora para pruebas.
3. **GNSS Master** - conexión al receptor RTK por **USB**, cliente NTRIP (corrección en tiempo real contra un caster) y alimentación del fix corregido al sistema como *mock location*, para que tanto el mapa del Operador como el envío de posición usen automáticamente la posición RTK en vez del GPS interno del tablet.

Todo esto se controla desde el engranaje (⚙) abajo a la derecha en la pantalla de login - visible solo cuando la app corre empacada como app nativa (no aparece en el navegador normal), y accesible ANTES de iniciar sesión (el envío de posición es una función del dispositivo, no de la sesión de un operador).

## Filosofía de los ajustes: sin opciones que solo empeoran el sistema

A pedido explícito del usuario: si una opción (precisión baja, sin buffer, sin wakelock, detección de parada, distancia/ángulo como filtro adicional) nunca sería mejor que el default, no se expone como ajuste - el código simplemente siempre usa el mejor modo. Lo único que de verdad tiene sentido tocar en campo es el **intervalo de envío** (para pruebas, ej. moverlo de 1s a 2-3s) y la **contraseña** (si el servidor la exige). Esto es intencional, no una limitación - menos ajustes, menos formas de dejar el sistema en un estado "tonto" sin darse cuenta.

## Qué ya está construido

- Proyecto Capacitor + Android generado con la herramienta oficial (`npx cap add android`), no escrito a mano - reduce el riesgo de un Gradle mal armado.
- `MainActivity.kt`: modo inmersivo (oculta barra de estado/navegación, un swipe la muestra un momento), pantalla que nunca se apaga sola (`FLAG_KEEP_SCREEN_ON` - un press real del botón de encendido sí bloquea igual, ninguna app puede evitar eso), brillo siempre al máximo mientras la app está abierta (a nivel de la propia ventana, sin permiso especial ni tocar el brillo global del sistema).
- **Traccar** (`TraccarSenderPlugin`/`TraccarSenderService`/`TraccarUplink`, Kotlin) - servicio en primer plano con GPS y wakelock siempre activos, protocolo OsmAnd:
  - Servidor "principal" auto-armado desde la URL del servidor GAGA + `/gps` + token (sin volver a escribir la URL aparte); servidores adicionales opcionales administrables a mano.
  - **Intervalo de envío (s)** editable, **contraseña** opcional (protocolo OsmAnd).
  - **Buffer sin conexión** siempre activo: si un envío falla, se guarda (JSON acotado a 300 puntos en SharedPreferences, no una base de datos aparte) y se reintenta en el próximo envío exitoso.
  - **Envío manual** ("Enviar ubicación ahora") - funciona aunque el envío continuo esté apagado, igual que en Traccar Client real.
  - **Bitácora** ("Mostrar estado") - últimos 50 intentos de envío con hora, servidor, éxito/error.
  - **Restaurar intervalo por defecto** - regresa solo el intervalo a 1 segundo, sin tocar servidor/token/id/contraseña.
- `RtkNtripPlugin` (Kotlin) - USB serial real (`usb-serial-for-android`, soporta FTDI/CP210x/CH340/PL2303), parser NMEA (GGA/RMC) real, cliente NTRIP v1/v2 real (handshake HTTP + heartbeat GGA + stream RTCM), y el puente a `LocationManager.setTestProviderLocation` (mock location).
- `packages/android-bridge` - la interfaz TypeScript hacia esos dos plugins, consumida por `apps/web-app`.
- `DeviceSettingsPanel.tsx` (`apps/web-app/src/features/device-settings/`) - la pantalla de configuración completa (servidor/token/id, intervalo/contraseña, bitácora, USB, NTRIP, estado del fix en vivo), accesible desde el engranaje del login.
- CORS habilitado en el backend (`apps/backend/src/app.ts`) y `androidScheme: 'http'` + `usesCleartextTraffic="true"` - necesarios para que el WebView de la app hable con un backend sin TLS (servidor de pruebas); ya desplegado y confirmado funcionando contra `app.gaga-maquinaria.com`.
- `npm run cap:sync` (dentro de esta carpeta) ya se probó de punta a punta en este entorno: compila `apps/web-app`, copia el `dist/` a `www/`, y corre `cap sync android` - **sin errores**. Ya se compiló, instaló y probó en una tableta real (Samsung SM-X306B) con login funcionando de extremo a extremo.

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

## Limitaciones conocidas (honestas)

- El RTK/NTRIP corre mientras la app está viva - no es un servicio 100% independiente de la actividad (a diferencia de Traccar, que ya corre en un foreground service real con wakelock). Para el caso de uso real (tableta con pantalla encendida en la máquina durante el turno) no debería notarse.
- Esta app siempre usa el `LocationManager` nativo de Android para GPS, nunca Google Play Services Fused Location - a propósito, para no sumar esa dependencia pesada. Si algún día se necesita de verdad la variante Fused (mejor precisión en interiores/con GPS débil), es una tarea aparte concreta.
- El buffer sin conexión ahora vive en SQLite (`OfflineBufferStore.kt`, no un JSON en SharedPreferences) con tope de seguridad de 200,000 puntos (a 1 fix/segundo, más de dos días completos) - una desconexión de horas no pierde nada. Al reconectar, la posición EN VIVO se manda de inmediato (nunca espera al histórico) y el histórico se drena aparte con hasta 8 envíos en paralelo (el rate limit del backend es 6000/min por dispositivo, con margen de sobra) - un backlog de varias horas se pone al día en minutos, no bloquea nunca la posición actual.
- Sin pruebas de campo todavía contra un receptor RTK real ni un caster NTRIP real - la primera vez que se pruebe con hardware real es la prueba de verdad de ese código (el envío de posición y el login sí ya se probaron de extremo a extremo en una tableta real).
