# GAGA Operador (Android)

Este APK sirve para **cualquier rol** (Admin, Encargado de Proyecto, Supervisor, Operador) - es el mismo `web` de siempre empacado con Capacitor, con un solo login que decide la vista según el rol, igual que en el navegador. Un dispositivo recién instalado queda en **modo básico**: solo login, sin pedir ningún permiso extra. Las 3 piezas de abajo (Traccar/GNSS Master) solo son relevantes para Operador, y quedan ocultas hasta que alguien del equipo activa el **"Modo Operador"** desde Ajustes con un código interno de 4 dígitos (ver `DeviceSettingsPanel.tsx`, constante `OPERATOR_MODE_CODE`) - una vez activado no se puede desactivar sin reinstalar la app. Esto evita que cualquiera que instale el APK active el envío de datos por accidente o a propósito.

**El login funciona sin configurar nada** - el APK, sin importar el rol, apunta automáticamente a `https://app.gaga-maquinaria.com` (`PRODUCTION_SERVER_URL` en `web/packages/client/src/deviceConfig.ts`) mientras nadie haya guardado un servidor distinto en Ajustes. Esto es a propósito: un Admin/Encargado/Supervisor debe poder instalar el APK e iniciar sesión de inmediato, sin nunca tener que abrir Ajustes a configurar a dónde apuntar - eso solo tiene sentido para Operador (que sí necesita elegir servidor/token/id de telemetría). Este fallback solo aplica dentro de la app nativa (`Capacitor.isNativePlatform()`); en el navegador normal siempre es mismo origen, sin cambios.

En modo operador, el APK unifica en un solo lugar las 3 apps que hoy usa la tableta:

1. **Operador GAGA** (mapa, alertas, turnos, incidentes) - el mismo código web que ya corre en el navegador, sin fork. Vive en `web`, esta app solo lo empaqueta con Capacitor.
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
- **GNSS Master** (`RtkNtripPlugin`/`UsbSerialManager`/`NtripClient`/`SwMapsOutputServer`/`RateTracker`, Kotlin) - paridad con la app real:
  - **USB**: deteccion automatica de dispositivos conectados/desconectados (`ACTION_USB_DEVICE_ATTACHED`/`DETACHED`, refresca la lista sola en el front sin boton), seleccionar + Conectar, estado "Conectado" con nombre del dispositivo y **data rate real** (B/s o KB/s, calculado con `RateTracker`), **baud rate editable** (default 460800, el real de la mayoria de receptores RTK de gama alta - antes tenia 115200 por error).
  - **NTRIP**: address/puerto/mount point/usuario/contrasena (ya existian) + **version V1/V2 seleccionable** (V1 manda el formato minimo original sin headers HTTP/1.1 extra, V2 el completo) + **data rate real** del stream RTCM recibido.
  - **Modo de correccion**: selector NTRIP Client / PointPerfect / USB Serial - solo NTRIP Client funciona hoy, los otros dos se guardan y se muestran bloqueados "proximamente" en el front (contemplados a proposito, sin rehacer el selector despues).
  - **Ubicacion simulada** y **Output to SW Maps** ahora son toggles reales que reflejan el estado actual (antes "Output to SW Maps" no existia) - SW Maps se implementa como un servidor TCP local en `SwMapsOutputServer.kt` (puerto configurable, default 11123, solo localhost) que retransmite el NMEA crudo del receptor a cualquier app que se conecte (SW Maps: External GNSS > TCP > 127.0.0.1:puerto).
  - **Servicio GNSS: Activar/Desactivar/Reiniciar** - un control en el front (`DeviceSettingsPanel.tsx`) que orquesta USB+NTRIP+mock location+SW Maps juntos en el orden correcto, sin logica nueva del lado nativo (cada pieza sigue siendo un plugin independiente).
- **Automatización / provisión rápida** - pensado para instalar la app en una tableta nueva y que quede operando sola:
  - **Botón "Configuración rápida" + código de 4 dígitos** (`DeviceSettingsPanel.tsx`, código en una constante al inicio del archivo, cambiar ahí si hace falta) - rellena de un golpe servidor/token/credenciales NTRIP conocidas y activa el "modo automático". El identificador del dispositivo y el mount point NUNCA se rellenan solos - varían por tableta/ubicación, se quedan manuales a propósito.
  - **Envío de posición persiste solo** (`TraccarPrefs.autoStart`, Kotlin) - una vez que se le da "Iniciar envío continuo" una vez, se retoma solo si se cierra/reabre la app (`MainActivity.resumeTraccarIfNeeded()`) y hasta si se reinicia la tableta completa (`BootReceiver.kt`, escucha `BOOT_COMPLETED`).
  - **Modo automático del RTK/NTRIP** (`RtkPrefs.autoModeEnabled`, activado por el código de arriba) - al conectar el USB del receptor (se detecta por vendor id de u-blox, `0x1546`, con `baudRate` guardado) se conecta solo y arranca NTRIP solo (si ya hay un mount point guardado) + ubicación simulada; al desconectar el USB, todo eso se apaga solo y el sistema vuelve al GPS normal de la tableta - sin tocar nada a mano, ni una vez.
  - **Bloqueo de ajustes con contraseña** (`web/packages/client/deviceConfig.ts`, `localStorage`) - opcional, vacío por defecto. Una vez puesta, la pantalla de ajustes pide la contraseña antes de mostrar nada, para que un operador no pueda entrar a cambiar la configuración por accidente o a propósito.
- `app/packages/android-bridge` - la interfaz TypeScript hacia esos dos plugins, consumida por `web`.
- `DeviceSettingsPanel.tsx` (`web/src/features/device-settings/`) - la pantalla de configuración completa (servidor/token/id, intervalo/contraseña, bitácora, USB, NTRIP, estado del fix en vivo), accesible desde el engranaje del login.
- CORS habilitado en el backend (`backend/src/app.ts`) y `androidScheme: 'http'` + `usesCleartextTraffic="true"` - necesarios para que el WebView de la app hable con un backend sin TLS (servidor de pruebas); ya desplegado y confirmado funcionando contra `app.gaga-maquinaria.com`.
- `npm run cap:sync` (dentro de esta carpeta) ya se probó de punta a punta en este entorno: compila `web`, copia el `dist/` a `www/`, y corre `cap sync android` - **sin errores**. Ya se compiló, instaló y probó en una tableta real (Samsung SM-X306B) con login funcionando de extremo a extremo.

## Qué falta y por qué no lo hice aquí

No hay SDK de Android, Gradle nativo ni `adb` instalados en este entorno - solo Node/npm. Pude generar y sincronizar el proyecto Capacitor (eso es JavaScript puro), pero **nunca compilé el APK ni probé nada contra hardware real** (ni el receptor RTK, ni el caster NTRIP, ni el mock-location). El código Kotlin está escrito con cuidado y sigue la documentación oficial de cada pieza (Capacitor plugin API, `usb-serial-for-android`, NTRIP v1/v2, `LocationManager`), pero la primera compilación real en Android Studio es también la primera vez que un compilador de verdad lo revisa - trátalo como una v1 sólida, no como código ya probado en campo.

## Pasos en Android Studio

1. `File > Open` → selecciona `app/android/android` (no la raíz del repo).
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

Cada vez que cambie algo en `web` y quieras que el APK lo lleve:

```bash
cd app/android
npm run cap:sync
```

Esto recompila `web`, copia el resultado a `www/`, y sincroniza `android/`. Después, en Android Studio, vuelve a compilar/instalar.

## Modo Kiosko (tableta bloqueada dentro de la app)

Para una tableta montada en un vehículo (ej. Samsung Tab Active 5 con modo sin batería, que enciende/apaga sola con la corriente del vehículo) que debe abrir la app sola y no dejar salir a un operador normal. Implementado con las APIs estándar de Android para "dispositivos dedicados" (`Device Owner` + `Lock Task Mode`) - **sin depender de Knox Manage/Knox Configure ni de ninguna suscripción de Samsung**. Knox en sí (la plataforma de seguridad de hardware que trae cualquier Samsung) no bloquea ni interfiere con esto - es la capa PAGADA de Knox (Knox Manage/Configure, gestión de flotas por consola web) la que es opcional y no se usa aquí.

### Qué es cada pieza

- `kiosk/KioskAdminReceiver.kt` + `res/xml/device_admin_policies.xml` - requisito de Android para que la app pueda pedir ser "Device Owner" (dueño del dispositivo, el nivel de control más alto que existe en Android, normalmente reservado para MDMs empresariales).
- `kiosk/KioskManager.kt` - una vez que la app YA es Device Owner, activa `Lock Task Mode` (bloquea recientes/inicio/barra de estado/notificaciones) y registra la app como pantalla de inicio automática.
- `kiosk/KioskPlugin.kt` - puente hacia el panel de Ajustes (`DeviceSettingsPanel.tsx`, sección "Modo Kiosko") - ahí se activa/desactiva con un switch, protegido por la misma contraseña de "Bloqueo de ajustes".
- `MainActivity.dismissKeyguard()` - hace que la app se muestre encima de la pantalla de bloqueo al arrancar.
- `BootReceiver.kt` - relanza la app en cada arranque completo de la tableta si el Modo Kiosko está activado.

### Paso manual obligatorio - una vez por CADA tableta física, esto NO se puede hacer desde aquí

"Device Owner" es un estado que vive dentro de esa tableta en concreto - no viaja con la app ni se copia al instalar el mismo APK en otra tableta. Cualquier tableta nueva que se vaya a usar en Modo Kiosko necesita este mismo procedimiento, una vez, como parte de su preparación inicial. (Para preparar muchas tabletas seguido sin hacerlo una por una a mano, existen "Android zero-touch enrollment"/"Knox Mobile Enrollment" - no implementado aquí, avisar si hace falta escalar a eso.)

Requiere una PC con el SDK de Android (trae `adb`, ya viene con Android Studio) conectada por USB a la tableta, y **que la tableta no tenga ninguna cuenta agregada en el momento de correr el comando** (Device Owner solo se puede activar sin cuentas - restricción de seguridad de Android, no de esta app). Esto es sobre el momento del comando, no algo permanente: **sí se puede agregar una cuenta de Google después**, para entrar a Play Store y descargar/actualizar apps normalmente.

1. Si la tableta ya tiene una cuenta (ej. la agregaste sin querer al abrir Play Store), quítala primero: Ajustes de Android > Cuentas > la cuenta > Quitar cuenta. Si eso no basta (a veces Samsung deja algún residuo), resetea de fábrica (Ajustes > Administración general > Restablecer) y no agregues ninguna cuenta durante la configuración inicial.
2. En Ajustes > Acerca de la tableta, toca 7 veces "Número de compilación" para activar Opciones de desarrollador, y ahí activa "Depuración USB".
3. Instala la app (`npm run cap:sync` + Run desde Android Studio, o instala el APK firmado).
4. Conecta la tableta a la PC por USB y confirma el diálogo de depuración USB en la tableta.
5. `adb` no está en el PATH de Windows por default (ni siquiera en la terminal integrada de Android Studio, confirmado) - hay que agregar la carpeta `platform-tools` del SDK al PATH del usuario **una sola vez** (típicamente `%LOCALAPPDATA%\Android\Sdk\platform-tools` en Windows; en Mac/Linux revisa dónde instaló Android Studio el SDK). Después de agregarlo, cierra y vuelve a abrir la terminal (una ya abierta no toma el cambio solo). Con eso listo, desde cualquier terminal:
   ```bash
   adb devices
   ```
   Debe listar la tableta (no "unauthorized" - si sale así, revisa el diálogo de depuración USB en la pantalla de la tableta). Luego el comando real:
   ```bash
   adb shell dpm set-device-owner com.gagagps.operator/.kiosk.KioskAdminReceiver
   ```
   Debe responder `Success:` - si da un error tipo "not allowed" o menciona una cuenta existente, la tableta no está limpia, repite el paso 1.
6. En Ajustes de Android (no de la app) > Pantalla de bloqueo, pon el bloqueo en **"Ninguno"** o **"Deslizar"** - con un PIN/patrón/contraseña real, Android SIEMPRE va a pedir el código al encender, sin importar el Modo Kiosko (ninguna app, ni siquiera Device Owner, puede saltarse eso - es una protección de seguridad real de Android). Si el bloqueo real importa para otra cosa, dilo y lo platicamos, pero para "cero toques al encender" tiene que estar así.
7. Abre la app, entra a Ajustes (engranaje en el login), pon una contraseña de ajustes si no tiene una, y activa el switch "Modo Kiosko".

Después de esto, la tableta queda lista: enciende con el vehículo, abre la app sola, sin pantalla de bloqueo, sin barra de estado, sin forma de salir salvo por Ajustes con la contraseña. Una cuenta de Google se puede agregar en cualquier momento después de este punto sin perder el estado de Device Owner.

### Cómo salir del kiosko para mantenimiento

Entra a la app (ya vas a estar dentro, no hay otra forma), ve a Ajustes con la contraseña, y apaga el switch "Modo Kiosko". Ahí sí vuelve a comportarse como una tableta normal (barra de estado, botón de inicio) hasta que se vuelva a activar. Quitar el estatus de Device Owner por completo (si algún día ya no se quiere ni la posibilidad) solo se puede haciendo un reset de fábrica.

### Limitación real, no ocultada

Un diálogo del sistema que necesite mostrarse (poco común, ya que el fix de permiso USB de `device_filter.xml` evita el más frecuente) podría quedar bloqueado por Lock Task Mode en algunos casos - no se ha probado en campo con el kiosko activo todavía. Probar bien antes de dar esto por resuelto en producción.

## Actualización automática (sin Play Store)

Para una tableta fuera de alcance físico (montada en un vehículo de prueba, en movimiento) que necesita recibir versiones nuevas de la app sin que nadie la toque. Reutiliza el mismo Device Owner del Modo Kiosko - **sin Play Store, sin cuenta de Google, sin ningún servicio de terceros**: el propio backend sirve el APK, y la app se instala sola a sí misma.

### Cómo funciona

- `update/AppUpdateManager.kt` revisa `GET /api/app/latest` (clave compartida, el mismo `TELEMETRY_SHARED_SECRET` que ya usa la tableta como "token" en "Servidor e identidad" - no es una clave nueva) **una vez al día a las 2 AM** (`update/UpdateScheduler.kt`, `AlarmManager` exacto - de madrugada a propósito, para no interrumpir un vehículo en operación durante el día), y también de inmediato al activar el switch desde Ajustes, al presionar "Buscar actualización ahora", o al recibir la señal de "Actualizar" desde el panel de Admin (ver abajo).
- Cada revisión (incluso si no hay versión nueva, y aunque el switch esté apagado) reporta al servidor qué `versionCode`/`versionName` tiene instalados esta tableta ahora mismo (`POST /api/app/report-version`) - alimenta la columna "Versión app" del detalle de un vehículo en el panel de Admin/Supervisor/Encargado.
- Si el `versionCode` publicado es mayor al instalado (`BuildConfig.VERSION_CODE`) **y el switch está activado**, descarga el APK completo de `GET /api/app/download` a un archivo temporal, calcula su SHA-256 y lo compara contra el que el servidor publicó. **Si no coincide (descarga interrumpida, corrupta, a medias), se descarta - nunca se instala un archivo sin verificar.**
- Solo si el hash coincide, se instala en silencio vía `PackageInstaller` (API oficial de Android, sin ningún diálogo en pantalla) - esto **requiere que la tableta ya sea Device Owner** (mismo aprovisionamiento de "Modo Kiosko" arriba, un solo comando `adb` por tableta física). Sin Device Owner, la revisión y descarga funcionan igual, pero la instalación se salta y queda un error visible en Ajustes.
- Tras instalarse, Android reinicia el proceso de la app - `BootReceiver.kt` (ya existente, ahora también escucha `ACTION_MY_PACKAGE_REPLACED`, no solo `BOOT_COMPLETED`) la vuelve a abrir sola si el Modo Kiosko está activo, igual que en un reinicio normal de la tableta.

### Activarlo

Se activa desde el mismo panel de Ajustes, sección "Actualización automática" (switch + botón "Buscar actualización ahora" para forzar una revisión inmediata). Muestra la versión instalada, la última publicada en el servidor, y el último error si algo falló (hash no coincide, no es Device Owner todavía, sin conexión, etc.).

### Publicar una versión nueva y actualizar tabletas - desde el panel de Admin, ya no por curl

1. Sube el `versionCode` (entero, siempre mayor al anterior) y `versionName` en `app/android/android/app/build.gradle` antes de compilar - la tableta compara contra `versionCode`, no contra el nombre.
2. Genera el APK firmado (Android Studio > Build > Generate Signed Bundle/APK).
3. En el panel de Admin (rol `admin` únicamente) > Sistema > "Actualización de la app": selecciona el archivo `.apk` y dale "Publicar" - **el `versionCode`/`versionName` se leen directo del propio APK** (`AndroidManifest.xml`, vía `app-info-parser`), no hay que escribirlos a mano ni arriesgarse a equivocarse de número; el backend calcula el SHA-256 él mismo al recibir el archivo. Si el `versionCode` del APK no es mayor al ya publicado, o el paquete no es `com.gagagps.operator`, se rechaza con un mensaje claro. Ahí mismo se ve el historial completo de versiones publicadas (quién, cuándo, tamaño).
4. Dos botones para forzar la actualización sin esperar a las 2 AM: **"Actualizar todos los dispositivos"** o, eligiendo una tableta del selector, **"Actualizar esta tableta"** - ambos piden confirmación explícita antes de mandar la señal.
   - **Límite real de este mecanismo, no oculto**: la señal viaja por el socket que la tableta ya mantiene abierto mientras el Operador está en uso (`useOperatorSocket.ts` avisa su `deviceId` al conectar, `FleetSocketServer.sendToDevice`/`broadcast` lo usan para dirigir el evento) - **solo llega a una tableta que tenga la app abierta y el socket conectado en ese momento**. Una tableta apagada, reiniciando, o sin datos móviles en ese instante simplemente no la recibe - se pone al día sola en su siguiente revisión programada (2 AM) o la próxima vez que alguien fuerce la actualización con ella ya conectada. No hay (todavía) un mecanismo tipo notificación push que la despierte estando apagada/dormida.
5. Sin forzar nada, cualquier tableta con el switch de Ajustes activado se pone al día sola en su revisión de las 2 AM.

### Gotcha real de Android, no de esta implementación

**El APK nuevo tiene que estar firmado con la MISMA llave (keystore) que el que ya está instalado** - es una regla dura de Android para cualquier actualización de cualquier app, no algo específico de este mecanismo. Si el keystore cambia (se pierde el archivo, se usa un build de debug sin firmar consistentemente, etc.), la instalación silenciosa falla (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`) y la única forma de recuperar la tableta es desinstalar la app a mano y volver a aprovisionarla desde cero (Device Owner incluido). Guarda el keystore de verdad, no solo en esta PC.

### Sin verificar en hardware real todavía

A diferencia del resto del Modo Kiosko (ya confirmado en campo), este mecanismo **no se ha probado con una actualización real de punta a punta** - el código se escribió y revisó a mano en un entorno sin SDK de Android ni tableta física (sí se probó de punta a punta el lado del servidor: publicar, listar historial, forzar actualización, reportar versión, todo verificado con Docker real). Puntos concretos a confirmar en el primer ensayo real:

- Que la instalación silenciosa de la app **sobre sí misma** (no de otra app) efectivamente no pida ningún diálogo de confirmación siendo Device Owner - es el comportamiento documentado por Android para este caso, pero nunca se confirmó en este proyecto específicamente.
- Que `AlarmManager.setExactAndAllowWhileIdle()` dispare de forma confiable a las 2 AM aunque la tableta lleve horas en reposo profundo (Doze) - Device Owner está exento de la restricción de alarmas exactas de Android 12+ según la documentación de Android para dispositivos dedicados, pero no se ha confirmado en este proyecto específicamente. Sin WorkManager de por medio (no se agregó esa dependencia para mantener el proyecto simple).
- Que el evento de "actualizar ahora" (socket) de verdad llegue y dispare `AppUpdate.checkNow()` con la app en primer plano real (Modo Kiosko activo) - la lógica está escrita y verificada a mano, sin poder abrir un socket real desde este entorno.

Recomendado: la primera vez, publica una versión de prueba (`versionCode` +1 sin cambios reales) y confirma en Ajustes (o con "Actualizar esta tableta" desde el panel) que la tableta la detecta, descarga, instala y vuelve a abrirse sola antes de confiar en esto para una actualización real.

## Limitaciones conocidas (honestas)

- El RTK/NTRIP corre mientras la app está viva - no es un servicio 100% independiente de la actividad (a diferencia de Traccar, que ya corre en un foreground service real con wakelock). Para el caso de uso real (tableta con pantalla encendida en la máquina durante el turno) no debería notarse.
- Esta app siempre usa el `LocationManager` nativo de Android para GPS, nunca Google Play Services Fused Location - a propósito, para no sumar esa dependencia pesada. Si algún día se necesita de verdad la variante Fused (mejor precisión en interiores/con GPS débil), es una tarea aparte concreta.
- El buffer sin conexión ahora vive en SQLite (`OfflineBufferStore.kt`, no un JSON en SharedPreferences) con tope de seguridad de 200,000 puntos (a 1 fix/segundo, más de dos días completos) - una desconexión de horas no pierde nada. Al reconectar, la posición EN VIVO se manda de inmediato (nunca espera al histórico) y el histórico se drena aparte con hasta 8 envíos en paralelo (el rate limit del backend es 6000/min por dispositivo, con margen de sobra) - un backlog de varias horas se pone al día en minutos, no bloquea nunca la posición actual.
- Ya probado de extremo a extremo con hardware real: receptor RTK u-blox por USB, caster NTRIP real (EarthScope), fix DGPS con 8-12 satélites, y confirmado que la posición que llega al servidor (`accuracy=2.5` en vez del ~10.5m del GPS de la tableta) es la corregida por RTK, no la del chip interno. Dos bugs reales que salieron en el proceso y ya están corregidos: faltaba activar DTR/RTS al abrir el puerto serial (el receptor no transmitía nada sin eso) y faltaba declarar `ACCESS_MOCK_LOCATION` en el manifest (sin eso la app nunca aparecía en "Seleccionar app de ubicación ficticia", sin importar reinicios ni reinstalaciones).
- El modo automático (auto-conectar USB, auto-arrancar NTRIP) todavía no se ha probado en campo con el flujo completo apagar/prender el receptor varias veces seguidas - la lógica está ahí y compilada, pero es la parte más nueva de esta ronda.
