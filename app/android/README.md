# GAGA App (Android)

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
  - **Ubicacion simulada** y **Output to SW Maps** ahora son toggles reales que reflejan el estado actual (antes "Output to SW Maps" no existia) - SW Maps se implementa como un servidor TCP local en `SwMapsOutputServer.kt` (puerto configurable, default 11123, solo localhost) que retransmite el NMEA crudo del receptor a cualquier app que se conecte (SW Maps: External GNSS > TCP > 127.0.0.1:puerto). **Sin uso real confirmado por el equipo (ronda posterior)** - se quito el control manual del panel de Ajustes (checkbox + puerto editable), pero la pieza nativa (`SwMapsOutputServer.kt`) se dejo intacta - `activateGnssService()`/`applyDefaultProvisioning()` la siguen arrancando sola en el puerto 11123 fijo, sin estorbar (nadie la usa, pero tampoco hace falta reescribirla si algun dia se necesita - solo agregar UI de vuelta).
  - **Servicio GNSS: Activar/Desactivar/Reiniciar** - un control en el front (`DeviceSettingsPanel.tsx`) que orquesta USB+NTRIP+mock location+SW Maps juntos en el orden correcto, sin logica nueva del lado nativo (cada pieza sigue siendo un plugin independiente).
- **Automatización / provisión rápida** - pensado para instalar la app en una tableta nueva y que quede operando sola (ver también "QR de aprovisionamiento" más abajo, que además evita adb):
  - **Código de 4 dígitos "Modo Operador", nombre del perfil y URL del servidor vienen del `.env` de la raíz del monorepo** (`VITE_OPERATOR_MODE_CODE`/`VITE_DEFAULT_PROFILE_NAME`/`VITE_PRODUCTION_SERVER_URL`, ver sección 5 de `.env.example` - se leen en build time vía Vite, `envDir: '..'` en `web/vite.config.ts`, y quedan compilados dentro del bundle de la app - seguro porque ninguno de los tres es sensible, son públicos de todos modos) - al activarlo (`applyDefaultProvisioning()`) deja de un golpe: servidor de producción con token/identificador vacíos (varían por tableta, manuales a propósito), envío continuo con intervalo en 1s pero **desactivado** (la persona lo activa a mano en cuanto llena token+identificador), actualización automática activada, baud rate 460800, salida SW Maps. **Deliberadamente sin ningún perfil NTRIP** - ver el bullet de abajo, las credenciales NTRIP ya no se compilan en el APK. El mismo botón "Restaurar valores por defecto" (Ajustes > Servicio GNSS) repite esto sin duplicar perfiles.
  - **NTRIP de fábrica: "Obtener del servidor" en vez de credenciales hardcodeadas en el APK (corrección de un riesgo de seguridad real, ver CLAUDE.md).** Una credencial NTRIP real (host/usuario/contraseña de una cuenta de EarthScope) vivió hardcodeada en el código fuente de este repo público - decompilar cualquier APK ya la exponía, y además cualquiera navegando el código en GitHub la veía en texto plano. Fix: esas credenciales viven SOLO en el backend (`NTRIP_DEFAULT_*` en el `.env` del backend, sección 6 de `.env.example` - NUNCA con prefijo `VITE_`, nunca se compilan en ningún bundle) y son editables en caliente desde el panel de Admin (Sistema > "Configuración NTRIP por defecto") - mismo patrón ya usado para `TELEMETRY_SHARED_SECRET` (`system_settings`, DB gana sobre `.env` en cuanto se edita una vez). La tableta las pide en vivo con `GET /api/app/ntrip-config?key=<mismo token de telemetría>` - un botón nuevo "Obtener del servidor" dentro de u-center > NTRIP Client > "+ Nueva configuración NTRIP" llena el formulario con la respuesta. Solo funciona una vez que el token de telemetría de esa tableta ya es válido (401 "Clave inválida" si no) - por diseño, el flujo esperado es: activar Modo Operador, llenar token+identificador a mano, activar envío continuo y confirmar "OK" en la bitácora, y RECIÉN ENTONCES usar "Obtener del servidor" en NTRIP.
  - **Envío de posición persiste solo** (`TraccarPrefs.autoStart`, Kotlin) - una vez que se le da "Iniciar envío continuo" una vez, se retoma solo si se cierra/reabre la app (`MainActivity.resumeTraccarIfNeeded()`) y hasta si se reinicia la tableta completa (`BootReceiver.kt`, escucha `BOOT_COMPLETED`).
  - **Auto-conectar USB/NTRIP incondicional** - al conectar el receptor (se detecta por vendor id conocido, ver `res/xml/device_filter.xml`) se conecta solo y arranca NTRIP solo (si ya hay un mount point guardado) + ubicación simulada; al desconectar, todo eso se apaga solo y el sistema vuelve al GPS normal de la tableta - sin ningún switch que alguien pueda dejar apagado sin querer.
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

### Receptor RTK por Bluetooth (recomendado sobre USB)

El receptor puede hablarle a la tableta por un módulo **HC-05 (SPP)** en vez del cable USB. Esto resuelve en hardware el problema de que el receptor siga drenando la batería de la tableta con el vehículo apagado: la tarjeta se alimenta del vehículo, no del puerto USB.

**El cable tiene prioridad, el Bluetooth es el respaldo.** Los dos alimentan el mismo camino (NMEA → ubicación simulada → envío al servidor) y no hay nada que elegir en ningún ajuste: si el USB está conectado, la app cierra el Bluetooth sola; si el cable se va, lo retoma. **Nunca los dos a la vez** - alimentarían el mismo fix dos veces y duplicarían el RTCM de salida. Se prefiere el cable por latencia (~1 ms contra 10-40 ms de SPP) y porque no se cae por interferencia de 2.4 GHz.

### Cable USB sin alimentación (data-only) para no drenar la tableta

El motivo original de pasar a Bluetooth era que el receptor seguía chupando corriente del puerto USB de la tableta con el vehículo apagado, y [eso no se puede cortar por software](#limitaciones-conocidas-honestas). Hay una solución de hardware más simple que conserva el cable:

**Corta el cable rojo (VBUS, 5 V) del USB. Deja intactos D+ (verde), D− (blanco) y GND (negro).**

Funciona porque el receptor se alimenta del vehículo: al ser un dispositivo autoalimentado, él mismo hace el pull-up en D+ para que el host lo enumere, sin necesitar los 5 V del puerto. La tierra **tiene que quedar conectada** - sin referencia común las líneas de datos no significan nada.

Con eso, al apagarse el vehículo el receptor muere, el USB se desconecta y la tableta no alimenta nada. Es el mismo resultado que el Bluetooth pero conservando la latencia y estabilidad del cable.

### Panel u-center dentro de la app

Ajustes tiene un botón **"u-center"** (dentro de "Receptor RTK y corrección NTRIP") que abre una réplica completa del programa real, para no necesitar una laptop en campo. Consolida todo lo relevante al receptor en un solo overlay con scroll (sin intentar replicar el manejo de ventanas acopladas de un programa de escritorio, no tiene sentido en una tableta):

- **Receptor** - conexión Bluetooth/USB, permiso de ubicación simulada, baud rate. Movido aquí desde Ajustes.
- **NTRIP Client** - perfiles, editor de mount point. Movido aquí desde Ajustes. Pura vista de estado (sin botón de conectar/desconectar) - la app ya conecta/desconecta NTRIP sola en cuanto el receptor USB o Bluetooth aparece/desaparece.
- **Satelites** - Satellite Position (sky plot polar, centro = cenit, 1 columna) + World Position (subpunto sobre un mapa mundial, 2 columnas, misma fila) - luego Satellite Level (barras de C/N0 por constelación) + Data (longitud, latitud, altitud MSL y elipsoidal, TTFF, Fix Mode, 3D/2D Acc, PDOP, HDOP, satélites) + Satellite Level History (sparkline de las últimas 300 lecturas por satélite, útil para ver uno intermitente que las barras no muestran), los tres a 1 columna cada uno en la fila siguiente.
- **Instrumentos** - Compass (rumbo), Speed Meter, Altitude Meter, Watch (hora UTC real del GPS, de RMC - no el reloj de la tableta).

**Todo el panel corre a la velocidad real del receptor (hasta 10Hz) SOLO mientras u-center está abierto.** Al abrir el overlay, la app le avisa al plugin nativo (`RtkNtrip.setDiagnosticsActive({active: true})`) que empiece a incluir satélites/PDOP/HDOP/VDOP/TTFF en el mismo push que ya manda la posición hasta 10 veces por segundo - antes esos datos solo se refrescaban 1 vez/seg (`getStatus()`, seguía siendo así fuera de u-center). Al cerrar el overlay se apaga solo - nadie paga el costo de cruzar la lista de satélites por el puente 10 veces/seg si no hay nada visible que lo necesite. Satellite Level History sube de 30 a 300 lecturas para seguir cubriendo ~30 segundos de historial real a esa velocidad.

**"World Position" muestra el subpunto de cada satélite sobre un mapa mundial simplificado** (contorno de baja resolución, la misma fidelidad que el propio panel de u-center) - punto grande es la posición del receptor, puntos chicos son los satélites. Deliberadamente NO es el mapa real del Operador (MapView, con tiles reales) - es puramente informativo dentro de este menú de diagnóstico, nunca se usa para navegar. El subpunto se calcula con geometría esférica real (elevación/azimut del satélite + posición propia + altitud orbital típica por constelación - fórmula estándar de seguimiento satelital, la inversa de calcular Az/El desde una posición orbital conocida), no es decorativo. Aproximado a propósito (altitud fija por constelación, Tierra esférica no elipsoidal) - sirve para "más o menos dónde", no para navegación. Fondo con un leve gradiente de "océano", ecuador/meridiano de Greenwich resaltados sobre el resto de la graticula, y borde propio - para que se sienta un instrumento real, no un dibujo suelto.

**Los puntos de satélite en Satellite Position y World Position se colorean por CONSTELACIÓN, no por señal** (GPS azul, GLONASS naranja, Galileo turquesa, BeiDou morado, QZSS amarillo, NavIC rosa - gris para cualquier otra) - mismo criterio que el u-center real, que también colorea su sky plot así. La calidad de señal (C/N0) sigue codificada por color solo en Satellite Level/Satellite Level History, que son los paneles pensados para eso. Una leyenda compacta bajo cada mapa muestra solo las constelaciones que de verdad están presentes en ese momento.

**Altitude Meter usa una aguja simple, no el dial de tambores giratorios de u-center** - misma información, sin el costo de un componente de dígitos rotativos que no aporta más valor diagnóstico.

**TTFF es una aproximación, no el valor real de u-blox.** El TTFF verdadero se mide desde el power-on del chip vía `UBX-NAV-STATUS` (protocolo binario, que esta app no parsea - UART2 solo emite NMEA). Lo que se muestra es tiempo desde que se estableció el enlace actual (USB o Bluetooth) hasta el primer fix - se reinicia en cada reconexión. Si el receptor sigue prendido y solo se reconectó el transporte, el número se parece a un "hot start" real; no es exacto pero sí informativo.

**3D/2D Acc requieren `GST` habilitado** en el puerto del receptor (ver el paso 4 de arriba) - sin él, el panel muestra `--` en esas dos filas.

### Baud rate del USB - por qué normalmente no hace nada

El ZED-F9P expone su propio puerto USB como **CDC-ACM nativo**, sin un chip puente FTDI/CP210x/CH340 detrás - lo mismo que u-center: su propia vista de puertos no tiene campo de baud rate cuando el target es USB (a diferencia de UART1/UART2, que sí lo tienen). El firmware del receptor no tiene ningún concepto de "baud rate" en ese puerto - es puro USB, sin trama serial real detrás que framear.

La app detecta esto (`UsbSerialDriver is CdcAcmSerialDriver`) y, cuando el dispositivo conectado es el propio u-blox, **oculta el campo de baud rate** y muestra en su lugar "Baud fijo - puerto nativo del receptor". Si algún día se conecta un receptor distinto a través de un chip puente real, el campo aparece y **se aplica de inmediato a la conexión ya abierta** (antes solo se guardaba para la siguiente conexión, cambiar el valor con el puerto ya conectado no hacía nada hasta desconectar y reconectar).

El baud real del Bluetooth (entre el HC-05 y el UART2 del receptor) tampoco se controla desde la app - es un límite real de la API de Bluetooth Classic de Android: RFCOMM no tiene ningún concepto de baud rate, esa velocidad vive físicamente entre el HC-05 y el receptor. Se configura una sola vez por hardware, en el paso 1 y 4 del aprovisionamiento de arriba.

**Por eso la app ya no muestra ningún campo editable de baud rate para el caso normal** - ni para USB nativo ni para Bluetooth, porque ninguno de los dos puede aplicarse desde ahí. En su lugar se muestra el valor real como solo lectura: `115200` para Bluetooth (una constante fija en el código, `BLUETOOTH_UART_BAUD_RATE` - **si algún día se reconfigura el HC-05 a otro valor, hay que actualizar esa constante a mano también**, no se lee del hardware) y "Sin baud rate" para USB nativo. El campo editable solo reaparece si algún día se conecta un receptor distinto a través de un chip puente real (FTDI/CP210x/CH340), caso en el que sí importa y sí aplica en vivo.

### Receptor - pura vista de estado, sin nada que elegir ni desconectar

La sección Receptor de u-center ya no deja elegir entre USB/Bluetooth ni tiene botón de desconectar. **Con un solo receptor real, nunca hubo nada genuino que elegir** - la conexión siempre fue automática del lado nativo (`RtkNtripPlugin.applyTransportPriority()`: USB conectado tiene prioridad y desconecta Bluetooth solo; sin USB, Bluetooth se reconecta solo). El selector manual solo invitaba a error humano y contradecía el objetivo del sistema - un botón de "Desconectar" no tiene sentido cuando la meta es que el RTK siga alimentando posición sin que nadie tenga que acordarse de apagarlo. La pantalla ahora solo muestra el estado real: conectado/sin conectar, tasa en vivo, total transferido en la sesión, y el baud rate de solo lectura.

### Precisión en el encabezado

Junto al estado del fix (`RTK FIJO · 3D/RTK FIJO`) se muestra la precisión actual, con formato dinámico: centímetros cuando importa la resolución fina (RTK FIJO/FLOTANTE, típicamente bajo 1 m), metros para el resto. Prefiere la medición real del receptor (GST) - si GST no está habilitado, cae a la estimación por categoría de fix y lo marca con `~` para no presentar una estimación como si fuera una medición real.

### Satellite Level History - constelaciones en fila, satélites en 2 columnas por constelación

Se probó primero una matriz de color satélites×tiempo (una celda por lectura) - resultó confusa, revertida. Luego cada satélite como columna angosta - también revertido. Diseño final: **cada constelación es un bloque** (BeiDou, luego Galileo a su derecha, luego GLONASS, sin envolver a una fila nueva - `flex-wrap: nowrap` + `overflow-x: auto` como salida si algún día no caben todas) y **dentro de cada constelación, los satélites se apilan verticalmente en 2 columnas** (CSS multi-column: llena la primera de arriba a abajo, sigue en la segunda) - una fila por satélite (ID + gráfica de línea de 52×40 + último valor). Evita que una constelación con muchos satélites (ej. GPS con 10+) haga el panel excesivamente alto. Panel de **ancho completo** (`uc-panel-full`), movido al final del menú.

El procedimiento completo de armado y configuración está en [Aprovisionamiento de un receptor RTK nuevo](#aprovisionamiento-de-un-receptor-rtk-nuevo-hardware--u-center).

### Paso manual obligatorio: mock location

Android bloquea por diseño que cualquier app finja tu ubicación, a menos que la elijas explícitamente. Después de instalar la app una vez:

`Ajustes > Opciones de desarrollador > Seleccionar app de ubicación falsa` → elige **GAGA App**.

Sin este paso, el botón "Activar ubicación simulada" de la pantalla de Integraciones falla con un mensaje claro (ya está manejado en el código, no truena la app) explicando este mismo paso.

## Aprovisionamiento de un receptor RTK nuevo (hardware + u-center)

Procedimiento completo para dejar operando un receptor **simpleRTK2B V3 (ZED-F9P)** con módulo **HC-05** hablándole a una tableta por Bluetooth. Se hace **una sola vez por receptor** y queda guardado en la memoria de la tarjeta.

Necesitas: el receptor, el módulo HC-05 (Steren ARD-305 o equivalente), un cable USB-C, y una PC con [u-center](https://www.u-blox.com/en/product/u-center) (el clásico, no u-center 2).

### Paso 1 - Programar el HC-05 a 115200 baudios

De fábrica viene en 9600, que no alcanza para 10 Hz.

1. Alimenta el pin `EN`/`KEY` con 5 V **antes** de darle corriente al módulo. Así arranca en modo AT (el LED parpadea lento, ~2 s).
2. Manda: `AT+UART=115200,0,0`
3. Confirma con `AT+UART?` que responda `+UART:115200,0,0`.

**Gotcha del Steren ARD-305**: las etiquetas **TXD y RXD vienen invertidas de fábrica**. Crúzalas respecto a lo que diga la serigrafía o no vas a tener comunicación.

### Paso 2 - Cableado definitivo al receptor

| HC-05 | ZED-F9P |
|---|---|
| TXD | TX2 |
| RXD | RX2 |
| VCC | 5 V |
| GND | GND |
| `EN` / `KEY` | **desconectado** |

**`EN`/`KEY` debe quedar sin conectar.** Si se deja puesto, el módulo vuelve a arrancar en modo AT y nunca pasa datos.

La tarjeta se alimenta **del vehículo**, no del puerto USB de la tableta. Ese es el punto de usar Bluetooth: el receptor se apaga con el vehículo y deja de drenar la batería de la tableta (ver [Cortar la alimentación por USB](#limitaciones-conocidas-honestas)).

### Paso 3 - Vincular con la tableta

`Ajustes de Android > Bluetooth` → vincular el HC-05, código **`1234`**.

Eso es todo del lado de la tableta. La app detecta sola el módulo ya vinculado, abre el puerto, reintenta si el enlace se cae, y le manda por ahí mismo las correcciones RTCM3 del caster NTRIP. No hay nada que configurar en Ajustes de la app.

En Android 12+ hace falta el permiso `BLUETOOTH_CONNECT`: en una tableta ya aprovisionada como Device Owner la app se lo concede sola sin diálogo; si no lo es, el botón "Permitir Bluetooth" de Ajustes abre el diálogo normal.

### Paso 4 - Configurar el receptor en u-center

Conecta el receptor a la PC por **USB-C** y abre u-center (`Receiver > Connection` → el COM correspondiente, 115200). Después `View > Configuration View`.

**Cada vista necesita su propio botón `Send`.** Dejar las casillas bien en pantalla no aplica nada. En la vista `MSG`, el `Send` aplica **solo el mensaje seleccionado en el dropdown** - si cambias de mensaje sin enviar, pierdes el cambio.

#### RATE (Rates) - tasa de navegación

| Campo | Valor |
|---|---|
| Measurement Period | `100` ms (debe mostrar 10.00 Hz) |
| Navigation Rate | `1` cyc |
| Time Source | `1 - GPS time` |

Este es un ajuste **global**, independiente de la configuración de puertos. El default de fábrica es 1000 ms (1 Hz) y configurar UART2 **no lo cambia** - es el error más fácil de cometer.

#### NMEA (NMEA Protocol) - precisión de la salida

| Campo | Valor |
|---|---|
| NMEA Version | `4.11` |
| High precision mode | **marcado** |
| Strict limit 82 chars max | **desmarcado** |
| Compatibility mode | desmarcado |

**Por qué importa**: el NMEA estándar manda la latitud como `ddmm.mmmmm`, 5 decimales de minuto. Un minuto son 1852 m, así que el escalón es de **1.9 cm** - estarías cuantizando la posición al mismo orden que la precisión del RTK. Con alta precisión pasa a 7 decimales: **0.19 mm**, despreciable. `Strict limit 82` es excluyente con esto: si queda marcado, las sentencias largas salen truncadas.

#### PRT (Ports) - el puerto que va al HC-05

| Campo | Valor |
|---|---|
| Target | `2 - UART2` |
| Protocol in | `0+1+5 - UBX+NMEA+RTCM3` |
| Protocol out | `1 - NMEA` |
| Baudrate | `115200` |
| Databits / Stopbits / Parity | `8` / `1` / `None` |

`in` necesita RTCM3 porque es por donde entran las correcciones que manda la tableta. `out` solo NMEA: el receptor no tiene nada que decirle a la app en UBX, y así el stream llega limpio sin binario de por medio.

No subas de 115200 - el HC-05 se vuelve inestable por encima.

#### MSG (Messages) - qué sentencias salen por UART2

Selecciona cada mensaje en el dropdown y ajusta **solo la casilla de UART2**. `Send` entre cada uno.

| Mensaje | UART2 | Resultado a 10 Hz |
|---|---|---|
| `F0-00 NMEA GxGGA` | `1` | 10 por segundo |
| `F0-04 NMEA GxRMC` | `1` | 10 por segundo |
| `F0-01 NMEA GxGLL` | `10` | 1 por segundo |
| `F0-02 NMEA GxGSA` | `10` | 1 por segundo |
| `F0-03 NMEA GxGSV` | `10` | 1 por segundo |
| `F0-05 NMEA GxVTG` | `10` | 1 por segundo |
| `F0-07 NMEA GxGST` | `10` | 1 por segundo |

**`GxGST` viene apagado de fábrica y vale la pena encenderlo**: trae la desviación estándar real de la posición calculada por el receptor. Sin él, el círculo de precisión de la app usa una tabla fija por tipo de fix (3 cm si RTK FIX, 50 cm si FLOAT, 2.5 m si DGPS) - una categoría, no una medición. Con GST activo, la app muestra y envía al servidor el error real, con milímetros de resolución.

**No toques I2C, UART1, USB ni SPI** - déjalos en `1`. En particular, GSV y GSA en USB son lo que alimenta la vista de satélites de u-center; si las apagas ahí te quedas sin diagnóstico.

**Por qué**: la app solo parsea GGA y RMC. Medido sobre tráfico real, una época completa con todas las sentencias pesa ~1,058 bytes; a 10 Hz eso es 10,580 bytes/s contra una capacidad de 11,520 a 115200 baudios - **92% bajo techo con 15 satélites, y afuera con 30 se pasa del 100%**. Con esta tabla el enlace queda en ~30%.

El valor `10` significa "cada 10 soluciones". Si prefieres, `0` las apaga del todo; `10` las conserva a 1 Hz por si algún día quieres ver satélites desde la tableta.

#### GNSS (GNSS Config) - constelaciones

Desmarca **Enable** en:

- **ID 1 SBAS** - con RTK no aporta nada y ocupa 3 canales
- **ID 5 QZSS** - es regional de Japón, en México no se ve ninguno; ocupa hasta 4 canales

Deja GPS, Galileo, BeiDou y GLONASS habilitados.

**Aviso**: al enviar un cambio de GNSS el receptor reinicia el subsistema de navegación. Pierdes el fix y tarda en readquirir - es normal.

**No uses esta vista para juzgar las señales L2.** `UBX-CFG-GNSS` es un mensaje heredado anterior a los receptores de doble frecuencia: su formato **no tiene campos para L2**, así que aunque el L2 esté activo (y en el F9P lo está de fábrica) esta pantalla siempre muestra solo L1C/A, E1, B1, L1OF. Para comprobar si el L2 se está rastreando de verdad, mira el último campo de las sentencias GSV en `View > Text Console`: `signalId 6` es GPS L2 CL, `signalId 3` es GLONASS L2 OF.

#### NAV5 (Navigation 5) - modelo dinámico

| Campo | Valor |
|---|---|
| Dynamic Model | `4 - Automotive` |

El default es "Portable", que asume movimiento genérico. "Automotive" aplica restricciones de aceleración y velocidad vertical propias de un vehículo terrestre, lo que estabiliza la solución y reduce ruido en movimiento.

### Paso 5 - Guardar en memoria

**Nada de lo anterior sobrevive un corte de corriente hasta este paso.**

`CFG (Configuration)` en la lista de la izquierda:

1. Selecciona **Save current configuration**
2. Marca los 4 dispositivos: **BBR + Flash + I2C-EEPROM + SPI-Flash**
3. `Send`

### Paso 6 - Verificar

**Alta precisión** - `View > Text Console`, mira una GGA:

```
$GNGGA,061737.20,1915.2325022,N,10342.9904467,W,2,12,1.22,541.495,M,-17.130,M,1.2,1948*50
                      ^^^^^^^ 7 decimales de minuto
```

Si ves solo 5, el `Send` de la vista NMEA no se aplicó.

**10 Hz sostenidos** - en el mismo Text Console, las marcas de tiempo de GGA consecutivas deben ir de 100 en 100 ms:

```
061737.20 → .30 → .40 → .50 → .60 → .70 → .80 → .90 → 061738.00
```

Si salen a 150-200 ms, el receptor no está dando abasto y hay que deshabilitar alguna constelación más. **Cuando no puede sostener la tasa, la baja en silencio sin avisar** - por eso hay que comprobarlo explícitamente, y repetirlo a cielo abierto donde rastrea el doble de satélites.

**Que el guardado funcionó** - desconecta el USB, vuelve a conectarlo, y dale `Poll` en la vista RATE. Si sigue en 100 ms, quedó. Si volvió a 1000 ms, repite el Paso 5.

**Edad de las correcciones** - el penúltimo campo de la GGA (`1.2` en el ejemplo) son los segundos desde la última corrección aplicada. Debe estar por debajo de 2-5 s. El último campo (`1948`) es el ID de la estación base que te está corrigiendo.

### Referencia rápida

**LEDs del receptor**

| LED | Estado | Significa |
|---|---|---|
| `PVT` verde | parpadea 10 veces/seg | 10 Hz sano |
| `PVT` verde | apagado | sin solución de posición (no ve satélites) |
| `NO RTK` rojo | fijo encendido | autónomo, sin correcciones aplicándose |
| `NO RTK` rojo | parpadeando | RTK FLOAT |
| `NO RTK` rojo | **apagado** | **RTK FIX** |

El parpadeo del LED rojo es ~1 Hz fijo y **no indica la tasa de navegación**. El del PVT sí.

**Calidad de fix** (campo 6 de la GGA) y precisión esperada

| Valor | Fix | Precisión horizontal |
|---|---|---|
| `1` | Autónomo | 1.5 - 3 m |
| `2` | DGNSS | 0.5 - 1.5 m |
| `5` | RTK FLOAT | 0.2 - 0.5 m |
| `4` | RTK FIX | 1 cm + 1 ppm |

El `+1 ppm` del RTK FIX es 1 mm por km de línea base: a 50 km de la base son 5 cm extra, así que un FIX real da ~6 cm, no 1 cm.

### Qué limita la precisión, por orden de impacto

1. **Distancia a la estación base.** Bajo 10 km el FIX es rápido y confiable; entre 30 y 50 km es marginal (FLOAT confiable, FIX intermitente); arriba de 50 km casi nunca hay FIX.
2. **Vista al cielo y multipath.** El RTK necesita fase de portadora, mucho más frágil que el código. **Bajo techo nunca vas a pasar de DGNSS**, por bueno que sea el NTRIP: hacen falta 35-45 dB-Hz en varios satélites y en las dos frecuencias.
3. **Antena y plano de tierra.** La antena de la simpleRTK2B necesita un plano de tierra metálico. El techo de la cabina sirve de plano de tierra y de punto de montaje con vista despejada a la vez - es el lugar correcto.
4. **Edad de las correcciones.** Bajo 2 s.
5. **Tasa de navegación.** No afecta la exactitud de cada época. Los 10 Hz son para que la tableta dibuje su posición fluida, no para medir mejor.

Si a cielo abierto sigues en DGNSS sin ningún L2, revisa en el `Packet Console` que el mount point mande observables de fase: necesitas `1005`/`1006` (posición de la base) más alguno de `1074`/`1084`/`1094`/`1124` o sus variantes. Un stream de solo código nunca puede dar RTK.

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
- `kiosk/KioskManager.kt` - una vez que la app YA es Device Owner, activa `Lock Task Mode` (bloquea recientes/inicio/barra de estado/notificaciones) y registra la app como pantalla de inicio automática. **Ya NO bloquea "Opciones de desarrollador"** (`DISALLOW_DEBUGGING_FEATURES` se probó y se quitó - rompía la ubicación simulada de RTK, ver más abajo "Suspensión por pérdida de corriente" punto 10) - Lock Task Mode ya impide llegar a Ajustes de todas formas mientras el kiosko esté activo. A diferencia de liberar Device Owner, apagar el Modo Kiosko es reversible sin adb en cualquier momento (`exitKiosk`).
- `kiosk/KioskPlugin.kt` - puente hacia el panel de Ajustes (`DeviceSettingsPanel.tsx`, sección "Modo Kiosko") - ahí se activa/desactiva con un switch, protegido por la misma contraseña de "Bloqueo de ajustes".
- `MainActivity.dismissKeyguard()` - hace que la app se muestre encima de la pantalla de bloqueo al arrancar.
- `BootReceiver.kt` - relanza la app en cada arranque completo de la tableta si el Modo Kiosko está activado, **o si el envío continuo (Modo Operador) ya está activado** aunque el kiosko siga apagado - una tableta operando sola no debe quedarse en la pantalla de login tras un reinicio solo porque el kiosko no se ha activado todavía. Sin ninguno de los dos (tableta de admin/pruebas), no se reabre sola.

### Dos formas de convertir una tableta en Device Owner

"Device Owner" es un estado que vive dentro de esa tableta en concreto - no viaja con la app ni se copia al instalar el mismo APK en otra tableta. Cualquier tableta nueva que se vaya a usar en Modo Kiosko o con actualización automática necesita pasar por una de estas dos, una vez, como parte de su preparación inicial:

1. **Comando `adb` desde una PC** (abajo) - requiere Android Studio/SDK y cable USB, pero se puede hacer sobre una tableta que ya tuvo algo de uso (mientras no tenga cuenta agregada en el momento del comando).
2. **Código QR de aprovisionamiento** (ver sección "Actualización automática" más abajo, "Generar QR de aprovisionamiento" en el panel de Admin > Sistema) - **sin computadora, sin adb, sin Android Studio** - solo funciona en una tableta recién reseteada de fábrica (parte del propio asistente de configuración inicial de Android). Es la opción real para que una persona externa sin conocimientos técnicos deje una tableta lista, con solo un factory reset + escanear un código.

No existe una forma de activar Device Owner desde los Ajustes normales de una tableta ya en uso (ni con cuenta, ni sin ella) - siempre es una de estas dos rutas.

### Comando adb - una vez por CADA tableta física

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
   adb shell dpm set-device-owner com.gaga.app/.kiosk.KioskAdminReceiver
   ```
   Debe responder `Success:` - si da un error tipo "not allowed" o menciona una cuenta existente, la tableta no está limpia, repite el paso 1.
6. En Ajustes de Android (no de la app) > Pantalla de bloqueo, pon el bloqueo en **"Ninguno"** o **"Deslizar"** - con un PIN/patrón/contraseña real, Android SIEMPRE va a pedir el código al encender, sin importar el Modo Kiosko (ninguna app, ni siquiera Device Owner, puede saltarse eso - es una protección de seguridad real de Android). Si el bloqueo real importa para otra cosa, dilo y lo platicamos, pero para "cero toques al encender" tiene que estar así.
7. **Paso manual, una sola vez por tableta**: si el modelo lo trae (Tab Active 5 sí), activa "No Battery Mode"/"Modo sin batería" en Ajustes de Android (Batería) - hace pass-through de corriente directo del cable al procesador cuando está conectada, evitando la microcarga constante de la batería física. No hay API pública para activarlo desde la app (ni Device Owner puede - es exclusivo de Ajustes del fabricante), así que se queda como paso manual de provisión, igual que la pantalla de bloqueo.
8. Abre la app, entra a Ajustes (engranaje en el login), pon una contraseña de ajustes si no tiene una, y configura RTK/NTRIP (incluida "Seleccionar app de ubicación falsa" en Opciones de desarrollador) y concede "Alarmas y recordatorios" (checklist propio en Ajustes > Modo Kiosko - necesario para que la suspensión por pérdida de corriente sea puntual, ver más abajo) **antes** del siguiente paso - Lock Task Mode impide llegar a Ajustes de Android por completo una vez activo el Modo Kiosko, así que cualquier pantalla del sistema que todavía haga falta tocar hay que dejarla lista antes (Modo Kiosko en sí ya NO bloquea Opciones de desarrollador como palanca aparte, pero Lock Task Mode sigue impidiendo llegar a cualquier Ajuste del sistema mientras esté activo).
9. Activa el switch "Modo Kiosko".

Después de esto, la tableta queda lista: enciende con el vehículo, abre la app sola, sin pantalla de bloqueo, sin barra de estado, sin forma de salir salvo por Ajustes con la contraseña. Una cuenta de Google se puede agregar en cualquier momento después de este punto sin perder el estado de Device Owner.

### Cómo salir del kiosko para mantenimiento

Entra a la app (ya vas a estar dentro, no hay otra forma), ve a Ajustes con la contraseña, y apaga el switch "Modo Kiosko". Ahí sí vuelve a comportarse como una tableta normal (barra de estado, botón de inicio) hasta que se vuelva a activar. Quitar el estatus de Device Owner por completo (si algún día ya no se quiere ni la posibilidad) solo se puede haciendo un reset de fábrica.

### Limitación real, no ocultada

Un diálogo del sistema que necesite mostrarse (poco común, ya que el fix de permiso USB de `device_filter.xml` evita el más frecuente) podría quedar bloqueado por Lock Task Mode en algunos casos - no se ha probado en campo con el kiosko activo todavía. Probar bien antes de dar esto por resuelto en producción.

## Señal instantánea por Firebase Cloud Messaging (pendiente de activar)

Decidido con el usuario como la vía profesional para que "Actualizar esta tableta"/"todos" del
panel de Admin llegue al instante sin importar la pantalla o si la app está cerrada (hoy solo
llega si el mapa está abierto con el socket conectado). **A propósito, todavía NO se agregó la
dependencia de Firebase Messaging al `build.gradle`** - confirmado que sin un `google-services.json`
real, la inicialización automática de Firebase (`FirebaseInitProvider`) puede tronar la app entera
al arrancar, el mismo tipo de bug que ya causó el incidente de `SCHEDULE_EXACT_ALARM`. Agregar la
dependencia sin el archivo real habría sido arriesgar ese mismo crash otra vez.

Ya listo del lado del backend: `POST /api/app/fcm-token` (clave compartida) guarda el token en
`devices.attributes.fcmToken`. Falta, cuando el usuario tenga los dos archivos de Firebase
(`google-services.json` para el cliente Android, credencial de cuenta de servicio para el backend):
agregar `com.google.firebase:firebase-messaging` a `build.gradle`, escribir
`power/FCMService.kt` (`FirebaseMessagingService`, `onMessageReceived` llama
`AppUpdateManager.checkAndInstall()`, `onNewToken` reporta a `/fcm-token`), y en el backend agregar
`firebase-admin` para mandar el push real desde `/api/app/force-update`.

## Suspensión por pérdida de corriente del vehículo

Pedido explícito: la tableta debe priorizar siempre el cable del vehículo sobre su propia batería -
si se corta la corriente, entra en ahorro máximo en vez de seguir operando con batería hasta
agotarla.

- **Gateado a Modo Kiosko activado (pedido explícito)** - una tableta sin kiosko (de prueba, de
  oficina) funciona normal sin ninguna limitación aunque se quede sin cargador; toda la lógica de
  abajo solo aplica con `KioskPrefs.getEnabled() == true`.
- `power/PowerSuspendScheduler.kt` programa un temporizador (`AlarmManager`, mismo mecanismo ya
  probado en hardware real para `UpdateScheduler`) de **15 segundos exactos** al perder la
  corriente (`ACTION_POWER_DISCONNECTED`, escuchado en `TraccarSenderService`) - bajado de 30s, que
  a su vez ya había bajado de 1 minuto y de 5, a pedido explícito del usuario. `setExactAndAllowWhileIdle()`
  es lo más exacto que permite Android (Device Owner ya tiene `SCHEDULE_EXACT_ALARM` otorgado solo).
  Si el cable vuelve antes, se cancela sin hacer nada.
- Si pasan los 15s sin corriente, `power/PowerSuspendAlarmReceiver.kt` manda un último aviso
  al backend (`POST /api/power-events/power-lost`, clave compartida) con la última posición
  conocida, apaga GPS/RTK/NTRIP (`TraccarSenderService.suspendGps()` + `RtkNtripPlugin.suspend()`)
  apaga la pantalla (`KioskManager.lockScreenNow()`, `DevicePolicyManager.lockNow()`) y, al final
  (ya que se mandó el aviso al backend), apaga WiFi (`WifiManager.setWifiEnabled(false)` -
  bloqueado para apps normales desde Android 10, pero Device Owner está exento de esa restricción,
  confirmado en documentación oficial) - se reenciende al salir de la suspensión, antes de intentar
  reportar nada al backend. **Datos móviles NO se tocan** - no existe una API pública confiable
  para que un Device Owner apague datos móviles en general (solo `DISALLOW_DATA_ROAMING`, que es
  otra cosa) - no se justifica arriesgar una implementación con reflexión/API oculta que podría
  dejar la tableta sin forma de reconectarse. En producción esto no importa, la tableta usa WiFi.
  El servicio en primer plano se queda vivo (para poder seguir escuchando el cable), pero deja de
  pedir ubicación, de mandar datos, y la pantalla se apaga para ahorrar batería al máximo.
  **Varios bugs reales reportados en campo (probado en hardware real, Tab Active 5), todos
  corregidos**:
  1. Con el mapa del Operador abierto, la pantalla se apagaba pero el socket del WebView seguía
     conectado, procesando alertas/posiciones de toda la flota en segundo plano. Fix:
     `power/PowerStatusPlugin.kt` (plugin nuevo) avisa a `useOperatorSocket.ts` para que
     desconecte su propio socket mientras dure (conserva sus listeners, solo pausa la conexión) y
     lo reconecte al salir. `useDeviceGeolocation.ts` tenía el mismo problema por otro lado -
     `navigator.geolocation.watchPosition()` del navegador es independiente del GPS nativo y
     seguía pidiendo el chip real aunque RTK ya estuviera desconectado - también se pausa/reanuda
     con la misma señal.
  2. Desconectar el socket solo evita eventos NUEVOS - una alerta ya sonando (ej. parada
     preventiva activa desde antes de perder corriente) seguía sonando de fondo. Fix:
     `useOperatorSocket.ts` también limpia el estado/sonido activo (`clearAlertState()` +
     `stopSound()`) en el mismo momento en que desconecta el socket.
  3. **El fix anterior no bastaba - confirmado en hardware real que la alerta seguía sonando de
     todas formas**. Dos causas reales, ambas corregidas: (a) `PowerSuspendAlarmReceiver.kt`
     bloqueaba la pantalla ANTES de avisarle al WebView de la suspensión - el JS que corta el
     sonido nunca alcanzaba a correr a tiempo; se reordenó (avisa primero, espera 400ms, apaga
     pantalla después). (b) causa de fondo más importante: `useOperatorSocket.ts` tiene un
     vigilante local independiente (`LOCAL_DISCONNECT_LEVEL1_MS`/`LEVEL2_MS`) que dispara su
     propia alerta "SIN CONEXIÓN PROLONGADA" a los 20s de que el socket esté desconectado - no
     sabía que la desconexión era intencional por la suspensión, así que volvía a sonar solo pasado
     ese tiempo aunque ya se hubiera limpiado al entrar en suspensión. Ahora ese vigilante se
     desactiva mientras dura la suspensión (`powerSuspendedRef`).
  4. **Botón Home despertaba la pantalla, confirmado en hardware real** - volumen/encendido/
     regresar/tareas quedaban correctamente deshabilitados (ni siquiera encendían la pantalla),
     pero Home sí. Causa raíz: Home está registrado como la única actividad de inicio del kiosko
     (`addPersistentPreferredActivity` en `KioskManager.enterKiosk`) - presionarlo trae
     `MainActivity` de vuelta al frente, y `dismissKeyguard()` deja la ventana con
     `setTurnScreenOn(true)` puesto de forma permanente, así que recibir foco enciende la pantalla
     sola, sin pasar por ningún botón físico real. Fix: `MainActivity.onResume()` vuelve a bloquear
     la pantalla de inmediato si sigue suspendida - más confiable que el receiver de
     `ACTION_SCREEN_ON` (ver siguiente punto) porque corre en el mismo ciclo de vida que causa el
     encendido. Más un tope de seguridad de 15s (`postDelayed`) por si el re-bloqueo inmediato no
     alcanza a pegar por alguna razón no probada aquí.
  5. **Límite real de Android, no de esta app**: ningún API público, ni siendo Device Owner, puede
     evitar que el botón físico de encendido prenda la pantalla por hardware. Mitigación: un
     receiver de `ACTION_SCREEN_ON` (`TraccarSenderService`, solo se puede registrar en runtime,
     no declarado en el manifest) vuelve a bloquear la pantalla de inmediato apenas se encienda
     mientras dure la suspensión - el botón "funciona" pero la pantalla parpadea y se re-bloquea
     sola, sin dejar tiempo útil para manipular nada.
  - **"Interacción física total desactivada" centralizada en un solo lugar (pedido explícito)** -
    los puntos 4 y 5 originalmente repetían la misma condición (`KioskPrefs.getEnabled()` +
    `PowerPrefs.getSuspended()`) cada uno por su lado. Se movió a
    `KioskManager.enforcePhysicalLockIfSuspended(context)` - único lugar que decide "¿debo volver a
    bloquear la pantalla?", gobernado siempre por el switch de Modo Kiosko (nunca se re-bloquea
    sola durante operación normal con corriente conectada, solo cuando el kiosko está encendido Y
    la tableta está realmente suspendida). `MainActivity.onResume()` y el receiver de
    `ACTION_SCREEN_ON` en `TraccarSenderService` solo llaman a esa función, ninguno vuelve a decidir
    la condición por su cuenta - si se necesita ajustar cuándo debe re-bloquearse, es un solo lugar
    que tocar.
  - **Confirmado en hardware real (Tab Active 5), dos rondas**: primero volumen, encendido,
    regresar y tareas (correctamente deshabilitados desde el inicio, ni encendían la pantalla). El
    HUD de batería del Operador (`useBatteryLevel.ts`) también confirmado funcionando. Segunda
    ronda - con los fixes 3-5 (alerta de fondo, botón Home) ya instalados: **confirmado que ningún
    botón enciende la pantalla mientras la tableta está suspendida**, botón Home incluido.
  6. **Con la tableta suspendida ya resuelto, pedido de seguir generalizando "interacción física
     total desactivada" a CUALQUIER momento con Modo Kiosko activo, no solo durante la suspensión**:
     volumen y el botón de encendido/apagado (con la pantalla PRENDIDA, operación normal) también
     deben quedar bloqueados - para que nadie pueda apagar la pantalla a mano mientras el kiosko
     esté activo. Dos mecanismos distintos, según qué permite Android:
     - **Volumen**: sí se puede interceptar de verdad - `MainActivity.dispatchKeyEvent()` consume
       `KEYCODE_VOLUME_UP`/`DOWN` mientras `KioskPrefs.getEnabled()` sea `true`, sin ningún truco de
       parpadeo, Android nunca llega a cambiar el volumen.
     - **Botón de encendido/apagado**: mismo límite real que ya aplicaba al despertar la pantalla -
       ninguna app puede consumir/bloquear el evento en sí. Mitigación simétrica a la de despertar:
       `KioskManager.shouldForceScreenBackOn(context)` (Modo Kiosko activo Y la tableta NO está en
       su suspensión legítima) - si la pantalla se apaga en ese estado, se revierte de inmediato
       (`TraccarSenderService.wakeScreenAndReopenApp()`, mismo mecanismo que ya trae la app de
       vuelta al recuperar la corriente), escuchando `ACTION_SCREEN_OFF` junto al `ACTION_SCREEN_ON`
       que ya existía. El botón "apaga" la pantalla un instante y se vuelve a prender sola.
     - **Confirmado en hardware real**: volumen bloqueado correctamente, y el botón de
       encendido/apagado con pantalla prendida sí se apaga un instante pero se vuelve a prender
       sola - comportamiento esperado, límite real de Android (nadie puede consumir ese botón).
  7. **Centralización profesional (pedido explícito, sin cambio de comportamiento)** - las 3 reglas
     de "interacción física total desactivada" (`isVolumeLocked`, `enforcePhysicalLockIfSuspended`,
     `shouldForceScreenBackOn`) viven agrupadas en un solo bloque de `KioskManager.kt`, documentado
     como el único lugar del proyecto que decide estas reglas. `MainActivity.dispatchKeyEvent()`
     (volumen), `MainActivity.onResume()` (botón Home) y el receiver de `ACTION_SCREEN_ON`/`OFF`
     en `TraccarSenderService` (cualquier otro botón) solo llaman a estas funciones - ninguno
     vuelve a evaluar la condición por su cuenta.
  8. **Confirmado explícitamente: el orden de suspensión no cambia con nada de esto** - durante los
     15s de gracia tras perder la corriente, la tableta sigue funcionando 100% normal (GPS, RTK,
     WiFi, sensores, sin ninguna limitación) - GPS/RTK/WiFi/pantalla solo se suspenden en el
     instante exacto en que se cumplen los 15s (`PowerSuspendAlarmReceiver.enterSuspension()`),
     nunca antes. Las reglas de bloqueo físico (punto 7) tampoco aplican durante esos 15s - solo
     entran en juego una vez que la tableta ya está realmente suspendida.
  9. **Bug real reportado en campo, CONFIRMADO con log real de hardware: tardó 26s en vez de los 15
     configurados**. El log mostró `canBeExact=false` - confirmado contra documentación oficial de
     Android 14 ("Schedule exact alarms are denied by default"): **Device Owner NO está en la lista
     de excepciones** (solo apps firmadas con el certificado de plataforma, apps privilegiadas, o
     apps en la lista blanca de optimización de batería) - la suposición usada en todo el proyecto
     hasta ahora (Device Owner recibe `SCHEDULE_EXACT_ALARM` otorgado solo) era falsa. Sin el
     permiso, tanto `PowerSuspendScheduler` como `UpdateScheduler` (revisión diaria 2 AM) caen a
     alarma INEXACTA, que Android retrasa a propósito por batería. **Fix real, documentado como
     único camino confiable** (no hay forma de que un Device Owner se auto-conceda esto sin acción
     del usuario): pedirlo una sola vez con el intent oficial `ACTION_REQUEST_SCHEDULE_EXACT_ALARM`
     - checklist nuevo en Ajustes > Modo Kiosko ("Alarmas y recordatorios"), mismo patrón que
     "Opciones de desarrollador"/mock-location. Un tap, no requiere adb ni código. **Sin confirmar
     en hardware real todavía** que conceder el permiso de verdad arregla el desfase - pendiente de
     la próxima prueba con logcat.
  10. **Bug real reportado en campo: activar Modo Kiosko rompía la ubicación simulada (RTK)** -
      `enterKiosk()` aplicaba `UserManager.DISALLOW_DEBUGGING_FEATURES`, que apaga TODA la pantalla
      de Opciones de desarrollador de Android - confirmado contra documentación oficial que esto
      incluye "Seleccionar app de ubicación falsa" (vive bajo el mismo switch maestro), rompiendo
      RTK en cualquier tableta con Kiosko activo. **Se quitó esa restricción por completo** -
      redundante de todas formas: Lock Task Mode ya impide llegar a Ajustes mientras el kiosko esté
      activo, así que nadie puede reactivar "Depuración USB" desde la tableta sin antes desactivar
      el kiosko con la contraseña. Sin pérdida real de seguridad, con una ganancia real de
      funcionalidad (RTK ya no se rompe).
  11. **Volumen forzado al máximo, mismo criterio que el brillo** (pedido explícito) -
      `MainActivity.forceMaxVolume()` fuerza `STREAM_MUSIC` (el stream que usa `useAlertSound.ts`,
      Web Audio API en el WebView) al máximo en `onCreate()` y se reafirma en `onResume()` - aplica
      siempre que la app esté abierta, con o sin Modo Kiosko (igual que el brillo), para que las
      alertas de audio nunca se pierdan por un volumen bajo dejado sin querer.
- El backend decide si esa posición cae dentro de una geocerca tipo **`parking`** ("Estacionamiento"
  en el selector de Geocercas - se reutiliza el tipo ya existente, no se creó uno nuevo) - si sí, no
  genera ninguna alerta aunque la tableta se quede así días y la batería se agote por completo; si
  no, dispara de inmediato una alerta real (`alert_events` tipo `power_loss`, severidad `danger`) -
  vehículo perdió corriente fuera de una zona autorizada.
- **Única forma de salir de la suspensión: que vuelva la corriente** (`ACTION_POWER_CONNECTED`,
  avisa `POST /power-restored`) - pedido explícito, corregido después de una primera versión que sí
  reactivaba con solo tocar la pantalla ("posible robo"). Con Modo Kiosko activado, la tableta no
  se debe mover ni manipular para nada - si hace falta usarla sin corriente, primero hay que
  desactivar el Kiosko desde Ajustes con la contraseña, igual que para cualquier otro mantenimiento.
  `TraccarSenderService.wakeScreenAndReopenApp()` enciende la pantalla (`WakeLock` corto) y vuelve
  a traer la app al frente - todo lo que ya tenía guardado (servidor, NTRIP, Modo Kiosko) sigue
  intacto, no hace falta reconfigurar nada al despertar.
- La alerta normal de "sin señal" (`SignalLostService`, por pérdida real de conexión) sigue
  funcionando exactamente igual - gana un método `suspendDevice()`/`resumeDevice()` nuevo que la
  salta por completo mientras dure una suspensión autorizada, sin tocar sus umbrales/lógica de
  siempre.
- **Indicador de batería en el HUD del Operador** (`useBatteryLevel.ts`, Battery Status API del
  navegador) - ahora expone `charging` además de `level`. Mientras carga, el HUD muestra
  "Conectada" en vez del porcentaje (pedido explícito: no tiene sentido ver "82%" bajando si en
  realidad está subiendo por el cable) - sin corriente, muestra el porcentaje normal.
- **Bloqueo de apagar/reiniciar con el botón físico**: confirmado en la documentación oficial de
  Android que el Modo Kiosko (Lock Task Mode) bloquea por default el menú de apagar/reiniciar
  (`LOCK_TASK_FEATURE_GLOBAL_ACTIONS`, nunca habilitado en `KioskManager.kt`) - no depende de tener
  PIN de pantalla. **Sin confirmar en hardware real todavía.** Límite real que ninguna app puede
  evitar: mantener presionado el botón de encendido 7-10s fuerza un apagado físico de emergencia,
  mecanismo de hardware a propósito.
- **Gap conocido, no cubierto a propósito**: si la tableta se reinicia (batería, no corriente)
  mientras está suspendida y SIGUE sin corriente al volver a arrancar, `BootReceiver` la reactiva
  igual (mismo criterio ya usado para Modo Operador) - la suspensión no sobrevive a un reinicio de
  la tableta. Caso raro (requiere batería agotándose justo durante un reinicio) - no se construyó
  nada especial para él.
- **Sin verificar en hardware real todavía** (mismo límite de siempre en este entorno, sin SDK de
  Android ni tableta física) - la primera compilación real en Android Studio es la primera vez que
  un compilador de verdad revisa este código.

## Reinstalación limpia (eliminar todo y volver a instalar)

Referencia rápida para copiar/pegar - borra la app, todos sus datos/permisos y el estado de
Device Owner de una tableta, y la deja lista de nuevo. Mismos conceptos que arriba, resumidos.

### 1. Eliminar por completo

Si la tableta **ya es Device Owner**, `adb` no puede desinstalarla directo - Android lo bloquea
mientras siga siendo Device Owner (protección real del sistema, para que nadie quite el control
de un MDM sin permiso). Hay que liberarlo primero DESDE la propia app:

1. Abre la app → engranaje de Ajustes → contraseña → sección "Modo Kiosko" → botón
   **"Liberar Device Owner (para desinstalar)"**.

Con eso hecho (o si la tableta nunca fue Device Owner), desinstala normal - borra la app y TODOS
sus datos/permisos automáticamente, sin comando aparte:

```bash
adb uninstall com.gaga.app
```

(Instalación vieja sin renombrar todavía: usa `com.gagagps.operator` en vez de `com.gaga.app`.)

### 2. Instalar y dejar operando

```bash
# 1. Instala el APK firmado
adb install ruta\al\app-release.apk

# 2. Vuélvela Device Owner (SIN ninguna cuenta agregada en la tableta en este momento)
adb shell dpm set-device-owner com.gaga.app/.kiosk.KioskAdminReceiver
```

Dos pasos manuales de Android (no de la app, no se pueden automatizar ni por adb):

- `Ajustes > Opciones de desarrollador > Seleccionar app de ubicación falsa` → **GAGA App**
  (solo necesario si se usa RTK).
- `Ajustes > Pantalla de bloqueo` → **Ninguno** (o Deslizar) - si no, el Modo Kiosko no abre
  "cero toques" al encender la tableta.

De ahí en adelante, el resto (Modo Operador, servidor/token/id, NTRIP, activar Kiosko) es
configuración normal dentro de la app.

## Actualización automática (sin Play Store)

Para una tableta fuera de alcance físico (montada en un vehículo de prueba, en movimiento) que necesita recibir versiones nuevas de la app sin que nadie la toque. Reutiliza el mismo Device Owner del Modo Kiosko - **sin Play Store, sin cuenta de Google, sin ningún servicio de terceros**: el propio backend sirve el APK, y la app se instala sola a sí misma.

### Cómo funciona

- `update/AppUpdateManager.kt` revisa `GET /api/app/latest` (clave compartida, el mismo `TELEMETRY_SHARED_SECRET` que ya usa la tableta como "token" en "Servidor e identidad" - no es una clave nueva) **una vez al día a las 2 AM** (`update/UpdateScheduler.kt`, `AlarmManager` exacto - de madrugada a propósito, para no interrumpir un vehículo en operación durante el día), y también de inmediato al activar el switch desde Ajustes, al presionar "Buscar actualización ahora", o al recibir la señal de "Actualizar" desde el panel de Admin (ver abajo).
- Cada revisión (incluso si no hay versión nueva, y aunque el switch esté apagado) reporta al servidor qué `versionCode`/`versionName` tiene instalados esta tableta ahora mismo (`POST /api/app/report-version`) - alimenta la columna "Versión app" del detalle de un vehículo en el panel de Admin/Supervisor/Encargado.
- Si el `versionCode` publicado es mayor al instalado (`BuildConfig.VERSION_CODE`) **y el switch está activado**, descarga el APK completo de `GET /api/app/download` a un archivo temporal, calcula su SHA-256 y lo compara contra el que el servidor publicó. **Si no coincide (descarga interrumpida, corrupta, a medias), se descarta - nunca se instala un archivo sin verificar.**
- Solo si el hash coincide, se instala en silencio vía `PackageInstaller` (API oficial de Android, sin ningún diálogo en pantalla) - esto **requiere que la tableta ya sea Device Owner** (mismo aprovisionamiento de "Modo Kiosko" arriba, un solo comando `adb` por tableta física). Sin Device Owner, la revisión y descarga funcionan igual, pero la instalación se salta y queda un error visible en Ajustes.
- Tras instalarse, Android reinicia el proceso de la app - `BootReceiver.kt` (ya existente, ahora también escucha `ACTION_MY_PACKAGE_REPLACED`, no solo `BOOT_COMPLETED`) la vuelve a abrir sola si el Modo Kiosko o el envío continuo están activos. **Para una tableta sin ninguno de los dos (de pruebas/admin)**, respeta cómo estaba justo antes de actualizar (pedido explícito) - si alguien la había cerrado a propósito, sigue cerrada después; si estaba abierta (alguien viéndola), se reabre en el mismo estado de siempre (sesión guardada, `App.tsx` la resuelve sola) - `AppStatePrefs.kt` guarda ese "¿estaba al frente?" en cada `onResume`/`onPause` de `MainActivity`.
- **Funciona también con la tableta suspendida por pérdida de corriente** (pedido explícito) - `AppUpdateManager.checkAndInstall()` enciende WiFi solo el tiempo necesario para la revisión (espera con `ConnectivityManager.registerNetworkCallback` a tener red real, no solo el radio encendido, tope de 25s), revisa/descarga/instala, y lo vuelve a apagar al terminar si la tableta sigue suspendida (`PowerPrefs.disableWifiIfStillSuspended` - no toca nada si volvió la corriente durante la revisión, `exitSuspension()` ya se encargó). Pantalla/GPS/RTK nunca se tocan - solo la red, lo mínimo necesario. Respaldo en `BootReceiver.kt` (mismo apagado de WiFi) por si el proceso muere a mitad de una instalación real, antes de que `AppUpdateManager` llegue a su propio paso de apagarlo. Si el APK nuevo se instala, la pantalla vuelve a bloquearse sola al reabrir (`KioskManager.enforcePhysicalLockIfSuspended`, ya cubierto por el mecanismo de re-bloqueo del Modo Kiosko) - no hace falta lógica aparte para eso.

### Activarlo

Se activa desde el mismo panel de Ajustes, sección "Actualización automática" (switch + botón "Buscar actualización ahora" para forzar una revisión inmediata). Muestra la versión instalada, la última publicada en el servidor, y el último error si algo falló (hash no coincide, no es Device Owner todavía, sin conexión, etc.).

### Publicar una versión nueva y actualizar tabletas - desde el panel de Admin, ya no por curl

1. Sube el `versionCode` (entero, siempre mayor al anterior) y `versionName` en `app/android/android/app/build.gradle` antes de compilar - la tableta compara contra `versionCode`, no contra el nombre.
2. Genera el APK firmado (Android Studio > Build > Generate Signed Bundle/APK).
3. En el panel de Admin (rol `admin` únicamente) > Sistema > "Actualización de la app": selecciona el archivo `.apk` y dale "Publicar" - **el `versionCode`/`versionName` se leen directo del propio APK** (`AndroidManifest.xml`, vía `app-info-parser`), no hay que escribirlos a mano ni arriesgarse a equivocarse de número; el backend calcula el SHA-256 él mismo al recibir el archivo. Si el `versionCode` del APK no es mayor al ya publicado, o el paquete no es `com.gaga.app`, se rechaza con un mensaje claro. Ahí mismo se ve el historial completo de versiones publicadas (quién, cuándo, tamaño).
4. Dos botones para forzar la actualización sin esperar a las 2 AM: **"Actualizar todos los dispositivos"** o, eligiendo una tableta del selector, **"Actualizar esta tableta"** - ambos piden confirmación explícita antes de mandar la señal.
   - **Límite real de este mecanismo, no oculto**: la señal viaja por el socket que la tableta ya mantiene abierto mientras el Operador está en uso (`useOperatorSocket.ts` avisa su `deviceId` al conectar, `FleetSocketServer.sendToDevice`/`broadcast` lo usan para dirigir el evento) - **solo llega a una tableta que tenga la app abierta y el socket conectado en ese momento**. Una tableta en Login/Ajustes, o con la app cerrada, no la recibe por este canal - se pone al día sola en su siguiente revisión programada (2 AM) o la próxima vez que alguien fuerce la actualización con ella ya conectada.
   - **Notificación push (Firebase Cloud Messaging) - ya conectado de punta a punta** - `update/FCMService.kt` recibe pushes y reporta el token de la tableta al backend (`POST /api/app/fcm-token`) sin importar pantalla/sesión, incluso con la app cerrada. `google-services.json` en `app/android/android/app/` (gitignored, no se sube al repo). Del lado del servidor, `backend/src/services/push/FirebasePushService.ts` (nuevo, `firebase-admin` v14+, API modular) manda el push real cuando se usa "Actualizar ahora"/"Actualizar todos" - la credencial de la cuenta de servicio vive en `FIREBASE_SERVICE_ACCOUNT_JSON` (`.env`, una sola línea entre comillas simples - mismo patrón que el resto de secretos del proyecto, nunca un archivo suelto que dependa de cómo Docker copia archivos). **Verificado con Docker real**: el backend arranca sin errores con la credencial real, y una llamada de prueba a `sendForceUpdatePush()` autenticó correctamente contra el proyecto de Firebase real (sin excepción de credenciales - el único "error" esperable sería sobre un token de dispositivo inválido, no sobre la cuenta de servicio). **Sin verificar en hardware real todavía** que un push de verdad le llegue a una tableta y dispare `AppUpdateManager.checkAndInstall()` (mismo límite de siempre, sin SDK de Android en este entorno) - el socket sigue funcionando en paralelo como respaldo instantáneo para cuando el operador sí tiene la app abierta.
5. Sin forzar nada, cualquier tableta con el switch de Ajustes activado se pone al día sola en su revisión de las 2 AM.

### Gotcha real de Android, no de esta implementación

**El APK nuevo tiene que estar firmado con la MISMA llave (keystore) que el que ya está instalado** - es una regla dura de Android para cualquier actualización de cualquier app, no algo específico de este mecanismo. Si el keystore cambia (se pierde el archivo, se usa un build de debug sin firmar consistentemente, etc.), la instalación silenciosa falla (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`) y la única forma de recuperar la tableta es desinstalar la app a mano y volver a aprovisionarla desde cero (Device Owner incluido). Guarda el keystore de verdad, no solo en esta PC.

### Sin verificar en hardware real todavía

A diferencia del resto del Modo Kiosko (ya confirmado en campo), este mecanismo **no se ha probado con una actualización real de punta a punta** - el código se escribió y revisó a mano en un entorno sin SDK de Android ni tableta física (sí se probó de punta a punta el lado del servidor: publicar, listar historial, forzar actualización, reportar versión, todo verificado con Docker real). Puntos concretos a confirmar en el primer ensayo real:

- Que la instalación silenciosa de la app **sobre sí misma** (no de otra app) efectivamente no pida ningún diálogo de confirmación siendo Device Owner - es el comportamiento documentado por Android para este caso, pero nunca se confirmó en este proyecto específicamente.
- ~~Device Owner está exento de la restricción de alarmas exactas de Android 12+~~ **- CORREGIDO, esto era falso**: confirmado con log real de hardware (`canBeExact=false`) y contra documentación oficial de Android 14, Device Owner NO está en la lista de excepciones. El permiso `SCHEDULE_EXACT_ALARM` hay que concederlo una vez desde Ajustes > Modo Kiosko ("Alarmas y recordatorios") - sin él, la revisión de las 2 AM sigue funcionando pero con una alarma inexacta que Android puede retrasar varios minutos. Ver "Suspensión por pérdida de corriente del vehículo" más arriba para el detalle completo. Sin WorkManager de por medio (no se agregó esa dependencia para mantener el proyecto simple).
- Que el evento de "actualizar ahora" (socket) de verdad llegue y dispare `AppUpdate.checkNow()` con la app en primer plano real (Modo Kiosko activo) - la lógica está escrita y verificada a mano, sin poder abrir un socket real desde este entorno.

Recomendado: la primera vez, publica una versión de prueba (`versionCode` +1 sin cambios reales) y confirma en Ajustes (o con "Actualizar esta tableta" desde el panel) que la tableta la detecta, descarga, instala y vuelve a abrirse sola antes de confiar en esto para una actualización real.

## QR de aprovisionamiento (Device Owner sin computadora)

Junto a los botones de forzar actualización (Admin > Sistema > "Actualización de la app") hay un botón **"Generar QR de aprovisionamiento"** - genera un código QR que deja una tableta **recién reseteada de fábrica** lista como Device Owner, sin adb, sin cable, sin Android Studio. Es el mecanismo estándar de Android para aprovisionar dispositivos dedicados a distancia (lo mismo que usan los MDM reales).

### Cómo se usa

1. Publica al menos una versión (arriba) - el QR siempre apunta a la última publicada.
2. Admin > Sistema > "Generar QR de aprovisionamiento".
3. En la tableta (reseteada de fábrica, sin ninguna cuenta agregada): en la primera pantalla de bienvenida, toca **6 veces** en cualquier parte de la pantalla - abre un lector de QR integrado de Android.
4. Conecta WiFi cuando lo pida (necesita internet para descargar el APK).
5. Escanea el código y sigue las instrucciones en pantalla. Android descarga el APK, verifica su SHA-256 contra el que trae el QR, lo instala y lo deja como Device Owner automáticamente.
6. Al abrir la app por primera vez, se aprovisiona sola (servidor de producción, envío continuo, NTRIP de fábrica) **sin pedir el código de "Modo Operador"** - escanear el QR ya fue la decisión de dejar esa tableta como operador/kiosko (`KioskAdminReceiver.onProfileProvisioningComplete`, `KioskPrefs.wasQrProvisioned`). Sigue siendo manual: el identificador/token de esa tableta en particular (varían por tableta) y activar el switch de Modo Kiosko.

### Qué NO resuelve el QR

- **Ubicación simulada para RTK** - sigue siendo un toggle manual de Android (`Ajustes > Opciones de desarrollador > Seleccionar app de ubicación falsa`), sin API pública para que ninguna app (ni Device Owner) lo conceda sola. Ver el checklist de abajo.
- El QR solo cubre tabletas **nuevas o reseteadas de fábrica** - una tableta ya configurada necesita `adb` (arriba) o un reset primero.

### Checklist de aprovisionamiento dentro de la app

`DeviceSettingsPanel.tsx`, sección "Receptor RTK y corrección NTRIP", detecta en vivo (sin permisos, solo lectura de `Settings.Global`) si faltan los 2 requisitos reales de Android para RTK - "Opciones de desarrollador" y "ubicación simulada" - y muestra un aviso con botón **"Abrir Ajustes de Android"** (deep-link directo, con `Ajustes > Acerca de la tableta` como respaldo si el atajo no funciona en ese fabricante) + **"Ya lo hice, verificar"** (reintenta `RtkNtrip.startMockLocation()` a propósito, solo cuando el usuario lo pide). El aviso desaparece solo en cuanto detecta que ya quedó configurado, sin que nadie tenga que cerrar nada a mano.

**Por qué el chequeo de ubicación simulada NO es un poll automático de fondo** (a diferencia de "Opciones de desarrollador", que sí se revisa solo cada pocos segundos): llamar `addTestProvider(GPS_PROVIDER)` registra un proveedor de prueba que **reemplaza el GPS real para toda la tableta** hasta que se le alimente una posición real - si esto corriera solo, en segundo plano, en CUALQUIER tableta (use RTK o no), le rompería el GPS real sin que nadie lo pidiera. Por eso solo se reintenta cuando el usuario presiona el botón a propósito, ya sabiendo que está configurando RTK en ese momento.

Device Owner (para Kiosko/actualización automática) **no tiene chequeo con botón de arreglo** - a diferencia de los dos anteriores, no hay forma de concedérselo a una app ya instalada y corriendo normal; solo se puede informar que falta (Ajustes > Modo Kiosko ya muestra este mensaje) y señalar que hace falta reiniciar el proceso de instalación (adb o QR).

### Sin verificar en hardware real todavía

Ni el QR de aprovisionamiento ni `onProfileProvisioningComplete` se han probado con una tableta reseteada de fábrica de verdad - el flujo del lado del servidor (generar el payload, el hash, la URL de descarga con el protocolo correcto detrás de un proxy) sí se verificó con Docker real. Antes de confiar en esto para una instalación real: resetea una tableta de prueba, genera el QR, y confirma que el flujo completo (Device Owner, apertura automática, aprovisionamiento sin pedir el código) funciona de punta a punta.

## Bug real reportado en campo: envío continuo se quedaba mudo con RTK sin conectar

Reportado como "la tableta tiene conexión pero no manda datos en envío continuo, aunque el envío manual sí funciona". Causa raíz confirmada en `MockLocationFeeder.kt`: activar "Activar todo" (o el auto-conectar del receptor USB) llamaba `startMockLocation()`, que secuestraba `GPS_PROVIDER` de inmediato (`addTestProvider()`) **sin esperar a que llegara ningún dato real del receptor**. Si RTK nunca llegaba a mandar un fix real (receptor desconectado, sin cable, o simplemente sin "Activar todo" respetando si de verdad había un receptor), ese proveedor se quedaba vacío para siempre - el GPS real de la tableta quedaba huérfano, y `TraccarSenderService` (que escucha `GPS_PROVIDER`) se quedaba mudo sin ningún error visible. El envío manual seguía "funcionando" solo porque `TraccarSenderPlugin.sendNow()` tiene un respaldo a `NETWORK_PROVIDER` (ubicación por WiFi/celular) que nunca se tocó - eso enmascaraba el problema real, dando la falsa impresión de que había conexión pero algo más andaba mal.

**Fix: activación perezosa de la ubicación simulada.** `start()` ya no secuestra `GPS_PROVIDER` - solo marca que se pidió ("Ubicación simulada" activada). El secuestro real (`addTestProvider()`) ocurre recién en `feed()`, la primera vez que llega un fix de verdad del receptor con coordenadas válidas. Sin receptor conectado (o mientras no manda ningún fix real), `GPS_PROVIDER` nunca se toca y el GPS real de la tableta sigue funcionando exactamente igual que si RTK nunca se hubiera activado - el envío continuo nunca se queda mudo por esto. El checklist de Ajustes ("Ubicación simulada" checkbox, solo lectura) también queda más honesto: solo se marca cuando de verdad hay un fix RTK real fluyendo, no con solo pedirlo.

**Sin verificar en hardware real todavía** (mismo límite de siempre, sin SDK de Android en este entorno) - recomendado probar explícitamente el caso que causó el bug: activar "Activar todo" con el receptor RTK desconectado, confirmar que el envío continuo sigue mandando datos (con el GPS real de la tableta), y luego conectar el receptor y confirmar que cambia a la posición corregida por RTK sin interrupción.

## Respaldo por red (WiFi/celular) para el envío continuo

**Confirmado en campo (Tab Active 5, GPS interno, adentro de un vehículo techado)**: sin RTK, el chip GPS interno puede quedarse minutos sin ningún satélite visible - comportamiento físico normal del hardware, no un bug (una antena de tableta es mucho menos sensible que un receptor RTK dedicado, y un techo/vehículo bloquea buena parte de la señal). Hasta ahora, mientras el GPS no entregaba nada, el envío continuo se quedaba completamente mudo - el envío **manual** ("Enviar ubicación ahora") ya tenía un respaldo a `NETWORK_PROVIDER` (ubicación aproximada por WiFi/celular, ver `TraccarSenderPlugin.sendNow()`), pero el continuo no.

**Fix**: `TraccarSenderService` ahora también se suscribe a `NETWORK_PROVIDER`, con una regla simple para no pelear con el GPS cuando este sí funciona: un fix de red solo se usa/manda si el GPS lleva más de `NETWORK_FALLBACK_GRACE_MS` (5 segundos) sin entregar nada. Con GPS funcionando normal, el comportamiento es idéntico a antes - el respaldo de red nunca interfiere. Con GPS ausente (adentro de un vehículo, sótano, etc.), en vez de quedarse mudo varios minutos, manda una posición aproximada por red cada `intervalMs` configurado - mucho menos precisa (decenas/cientos de metros contra unos metros de GPS real), pero mejor que ningún dato.

**Nota importante, no un efecto secundario nuevo**: el filtro anti-teletransporte (`PositionFilterService`, backend y frontend) sigue evaluando estos puntos igual que cualquier otro - si un fix de red llega muy lejos del último punto real, se descarta como salto implausible, tal como debe ser. El respaldo de red no se salta ninguna validación existente.

**Sin verificar en hardware real todavía** que el respaldo de red efectivamente entregue datos cuando el GPS está ausente - recomendado probar la misma tableta adentro de un vehículo techado (mismo escenario que causó el reporte original) y confirmar que ahora sí llegan posiciones (aunque menos frecuentes/precisas) en vez de silencio total.

### Corrección real, confirmada en campo: la primera versión de este fix retrasaba al GPS real

La primera implementación suscribía `NETWORK_PROVIDER` de forma **continua** (`requestLocationUpdates`), igual que `GPS_PROVIDER`, con el mismo listener. Reportado en campo: con GPS funcionando bien (sin RTK, tableta con buena señal), el envío pasó de cada 1 segundo a cada ~2 segundos, con saltos ocasionales más grandes - una regresión real causada por este mismo cambio, no por el GPS. Causa probable: Android/el fabricante agrupa o retrasa las entregas cuando hay dos proveedores suscritos a la vez con el mismo listener, sin importar que el segundo casi nunca se estuviera usando de verdad.

**Fix real**: `NETWORK_PROVIDER` ya no se suscribe de forma continua - se **consulta bajo demanda** desde un watchdog aparte (`networkFallbackRunnable`, corre cada `intervalMs` vía `Handler`) que no toca la suscripción de `GPS_PROVIDER` para nada. `GPS_PROVIDER` vuelve a comportarse exactamente como antes de todo este cambio - solo se le agregó la consulta de red como algo completamente aparte.

### Segundo hallazgo real, misma ronda: el respaldo de red tampoco llenaba los huecos

Confirmado en campo (mismo lugar exacto, versionCode 42 ya instalado): un salto de GPS de 16 segundos tampoco se llenó con ningún dato de red - el respaldo estaba ahí pero no hacía nada útil. Causa: `getLastKnownLocation(NETWORK_PROVIDER)` (la versión anterior de este watchdog) solo lee una **caché pasiva** - sin algo más en la tableta pidiendo activamente ubicación de red, esa caché puede quedar vacía o vieja indefinidamente, así que el respaldo nunca tenía nada real que mandar.

**Fix**: cambiado a `requestSingleUpdate()` - pide un fix de red **fresco de verdad** una sola vez cuando hace falta (GPS lleva ≥5s callado), no una suscripción continua (eso reintroduciría el bug anterior). Con protección contra pedir varias solicitudes superpuestas si la anterior nunca contesta.

**Duda seria pendiente, no resuelta todavía**: el usuario reportó que en el MISMO lugar/posición física, versiones anteriores de la app mandaban cada segundo sin fallar - si el ambiente no cambió, el hueco de 16s en el GPS en sí (no solo la falta de respaldo) podría seguir siendo un problema real más allá de lo ya corregido en esta ronda. **Sin verificar en hardware real todavía** - si después de esta versión el GPS sigue con huecos grandes en el mismo lugar donde antes no los tenía, el siguiente paso real es capturar `adb logcat` durante la prueba (filtrando por `TraccarSender`) para ver qué está pasando de verdad con `GPS_PROVIDER` durante esos huecos, en vez de seguir adivinando desde el código.

### Causa real de fondo encontrada con `adb logcat` real: el wake lock acotado a cada envío dejaba dormir al CPU entre fixes

Con la tableta conectada por USB a la misma PC (permiso explícito del usuario), se capturó `adb logcat` real durante una prueba en el mismo lugar techado donde se reportaba el problema. El resultado descartó por completo la hipótesis de "GPS débil": `GnssLocationProvider`/`GnssEngineManager_FLP` entregaban un fix real cada 1 segundo exacto, con 11-15 satélites - el chip GNSS funcionaba perfecto. El problema estaba en otra capa: comparando contra `NetdEventListenerService` (que registra cada consulta DNS real hecha por `com.gaga.app`, usado como proxy de "cuándo la app de verdad intenta mandar al servidor"), el envío real solo ocurría cada ~3-4 segundos, no cada 1 - la app estaba recibiendo el fix del chip pero tardando varios segundos en reaccionar a cada uno.

**Causa raíz**: una optimización de batería de una ronda anterior (documentada más abajo en este mismo archivo, sección de wake lock) había limitado `sendWakeLock` a sostenerse solo durante cada envío individual (`acquire()`/`release()` por cada fix), para dejar que el CPU volviera a dormir entre un envío y el siguiente. Eso permitía justo lo que rompía el requisito: con el CPU durmiendo entre fixes, Android agrupaba/retrasaba la entrega del callback de `GPS_PROVIDER` a su propio ritmo de Doze/App Standby en vez de despertar exacto cada segundo, aunque el chip sí producía un fix por segundo real a nivel de hardware.

**Se descartó la hipótesis alternativa (capa propietaria de Samsung, `SLocation`/`SemContextService`) antes de tocar código** - el usuario confirmó explícitamente que las 3 configuraciones de batería/ubicación relevantes de Samsung ya estaban bien configuradas sin restricciones, así que no era eso.

**Fix**: se revirtió la optimización - `sendWakeLock` ahora se adquiere una sola vez, al arrancar el envío continuo (`startLocationUpdates()`, sin timeout), y se mantiene sostenido TODO el tiempo que el envío continuo esté activo, no solo durante cada envío individual. Solo se libera de verdad en `suspendGps()` (perdida de corriente del vehículo) y en `onDestroy()`. **Requisito explícito del usuario, no negociable por batería**: "al servidor deben enviarse 1 petición cada segundo, si no hay rtk usar gps interno... cualquier opción al servidor" - un ritmo de envío inconsistente no es aceptable aunque ahorre algo de batería.

**Costo de batería aceptado a propósito, no un descuido**: mientras el envío continuo está activo, la tableta ya está operando con corriente del vehículo (mismo criterio que ya justifica el brillo de pantalla forzado al máximo) - el ahorro de batería real para cuando SÍ importa (tableta sin corriente) ya lo cubre por completo el sistema de suspensión por pérdida de corriente (`PowerSuspendAlarmReceiver.kt`), que sigue liberando este mismo wake lock sin cambios.

**Sin verificar en hardware real todavía** (mismo límite de siempre, sin SDK/tableta en este entorno) - pendiente que el usuario recompile/instale esta versión y confirme, en el mismo lugar techado donde se reportó el problema, si el envío ahora sí ocurre cada 1 segundo consistente en vez de cada ~3-4s.

## Bug real reportado en campo: el marcador propio del Operador no coincidía con lo que veían Admin/Supervisor

Reportado con capturas reales: el mismo vehículo, al mismo tiempo, se veía en un punto distinto en el mapa propio del Operador que en los paneles de Admin/Supervisor (que sí coincidían entre sí, ambos alimentados por el servidor). Causa raíz: son dos fuentes de ubicación completamente independientes del sistema operativo, aunque las dos lean "GPS" en teoría. `TraccarSenderService.kt` (lo que manda al servidor) pide `GPS_PROVIDER` crudo directo del `LocationManager` nativo de Android, sin mezcla de red. `navigator.geolocation.watchPosition()` (lo que usa el marcador propio del Operador en `useDeviceGeolocation.ts`) corre dentro del WebView/Chromium, que en Android normalmente resuelve vía Fused Location Provider de Google Play Services (ya instalado de fábrica en cualquier tableta con Play Store, sin relación con que la app declare o no esa dependencia) - una mezcla de GPS+WiFi+red celular, pensada para exteriores/interiores mixtos, que puede desviarse varias decenas de metros del GPS crudo, sobre todo en zonas urbanas con muchos puntos WiFi cercanos. Este proyecto ya evita a propósito depender de Fused Location en el código nativo (ver "Limitaciones conocidas" más abajo) - pero `navigator.geolocation` del WebView es una API del navegador, fuera de ese control, y usa lo que Android decida por su cuenta.

**Fix: relay del fix exacto, mismo patrón ya usado para `rtkFix`.** `RtkNtripPlugin.emitGpsFix(location)` (Kotlin, nuevo, companion object) - `TraccarSenderService.sendLocation()` lo llama con el MISMO objeto `Location` que está a punto de mandar al servidor (ya sea del listener de `GPS_PROVIDER` o del respaldo por red, cualquiera de los dos - es el único punto de la app donde se decide "esto es lo que se envía"), y lo notifica al WebView como evento `gpsFix`. `useDeviceGeolocation.ts` lo trata como una tercera fuente más, arbitrada por el mismo mecanismo de timestamp que ya usaba para no dejar que `navigator.geolocation` (más lento) pisara un fix más reciente de `rtkFix` (más rápido, solo con receptor RTK conectado) - si `rtkFix` ya entregó algo más nuevo, el `gpsFix` correspondiente se descarta solo, sin necesitar ninguna lógica de prioridad explícita. Sin RTK conectado, `gpsFix` pasa a ser la fuente que de verdad gana casi siempre (llega al mismo ritmo que el envío al servidor, 1/seg, más rápido que lo que en la práctica entrega `navigator.geolocation`) - el resultado es que el marcador propio del Operador muestra, por diseño, EXACTAMENTE el mismo punto que el servidor ya recibió, no una aproximación independiente que puede o no coincidir.

`navigator.geolocation.watchPosition()` se queda sin cambios como fuente base (nunca se quitó) - sigue siendo necesaria para: navegador normal fuera de la app nativa (sin plugin `RtkNtrip` disponible), y como respaldo mientras el envío continuo esté apagado o el servicio `TraccarSenderService` todavía no haya arrancado (sin eso, sin `gpsFix` disparando, el hook sigue funcionando solo con la fuente del navegador, igual que antes de este fix).

### Corrección real, reportada en campo tras publicar lo anterior: el marcador propio quedó inestable (se "teletransportaba" unos metros y regresaba)

Reportado con el vehículo detenido, RTK conectado pero **sin fix todavía** (buscando satélites): el círculo azul de precisión crecía y se achicaba sin parar, y la flecha propia saltaba unos metros y volvía, en vez de quedarse quieta. La arbitración por timestamp descrita arriba ("si `rtkFix` ya entregó algo más nuevo, se descarta solo") no bastaba - el problema no era `rtkFix` contra `gpsFix` (ninguno de los dos dispara sin fix real del receptor, ver `MockLocationFeeder`), sino `gpsFix` contra `navigator.geolocation`: con RTK sin fix, `GPS_PROVIDER` nunca se secuestra, así que `gpsFix` entrega el GPS crudo real de la tableta MIENTRAS `navigator.geolocation` sigue entregando su propia lectura por separado (normalmente Fused Location de Play Services, GPS+red combinados) - dos fuentes reales, cada una razonablemente estable POR SÍ SOLA, pero con un sesgo ligeramente distinto entre sí. Cada segundo, cualquiera de las dos que llegara con el timestamp más nuevo "ganaba" y el marcador saltaba a su punto - visualmente idéntico a una alternancia ida-y-vuelta entre dos posiciones fijas, no a ruido aleatorio.

**Fix real: prioridad de fuente, no solo timestamp más reciente.** `useDeviceGeolocation.ts` ahora registra el reloj real (`Date.now()`, no el timestamp del propio fix) de la última vez que llegó CUALQUIER fix nativo (`rtkFix` o `gpsFix`) en `lastNativeFixAtRef` - mientras haya uno de menos de `NATIVE_PRIORITY_WINDOW_MS` (3000ms, mismo umbral que `DEAD_RECKONING_MAX_MS`/`STALE_THRESHOLD_MS` ya usados en el proyecto), `navigator.geolocation` se ignora por completo, sin siquiera evaluarlo contra el filtro anti-teletransporte. Solo vuelve a competir cuando el nativo lleva más de esa ventana callado (envío continuo apagado, o fuera de la app nativa) - en ese caso el hook sigue funcionando exactamente como antes de todo este trabajo, solo con `navigator.geolocation`. En el caso normal (app nativa con envío continuo activo, con o sin RTK) esto deja una sola fuente compitiendo consigo misma la mayor parte del tiempo, eliminando la alternancia entre dos sesgos distintos - no toca el círculo de precisión en sí (`vehicleMarker.ts`, marcado "No modificar" en el código, no se tocó) ni ningún otro cálculo, solo decide cuál fix nuevo se deja entrar.

**Sin verificar en hardware real todavía** (mismo límite de siempre, sin SDK/tableta en este entorno) - pendiente que el usuario confirme en campo que el marcador propio ya no oscila, tanto con RTK conectado sin fix (el caso reportado) como con RTK entregando fix real y sin RTK en absoluto.

## Bug real reportado en campo: la batería del vehículo nunca se veía en el panel de Admin/Supervisor

Reportado como "no funciona ver cuánta batería tiene el vehículo" en el detalle de vehículo. Causa raíz: nunca fue un bug de un panel específico - `TraccarUplink.kt` (`sendOsmAnd()`) nunca mandó el parámetro `batt` del protocolo OsmAnd al servidor, en ningún camino (envío en vivo ni drenado del buffer). El backend ya sabía leer `batt` desde antes (`telemetry.routes.ts`, `Position.battery`) y ya lo guarda/reenvía sin cambios - `VehicleDetailPanel` (componente compartido de los 3 paneles) ya sabía mostrarlo - simplemente nunca llegaba nada que mostrar, en ningún panel.

**Fix**: `TraccarUplink.readBatteryPercent(context)` (nuevo) lee el nivel de batería de la tableta con `BatteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)` (0-100 directo, sin registrar ningún `BroadcastReceiver` de `ACTION_BATTERY_CHANGED` - más simple para una lectura puntual como esta, sin permiso adicional en el manifest). Se lee una vez por envío (en vivo y en cada ciclo del drenado del buffer) y se agrega como `&batt=<nivel>` a la query OsmAnd si el sistema lo reporta. **Nota real, no un descuido**: para puntos reenviados desde el buffer sin conexión, se manda la batería ACTUAL de la tableta, no la de cuando se capturó esa posición vieja (`OfflineBufferStore` no guarda ese dato) - aproximación razonable, mismo criterio que ya se usa para el `server_url` del drenado.

**Verificado con Docker real** (lado servidor, el nativo no se puede compilar en este entorno): `GET /gps?...&batt=73` guarda `battery: 73` en el estado de flota y lo devuelve tal cual en `/api/fleet/state` - exactamente lo que `VehicleDetailPanel` lee. En cuanto la tableta actualice a esta versión, la batería debería aparecer sola en los 3 paneles sin más cambios.

**Sin verificar en hardware real todavía** que `BatteryManager.BATTERY_PROPERTY_CAPACITY` reporte un valor real en la Tab Active 5 (documentado como posiblemente ausente en algunos fabricantes/emuladores - en ese caso el parámetro simplemente se omite, sin romper el envío).

## Bug real reportado en campo: la bitácora de Ajustes parecía mostrar envíos irregulares

Reportado como "no veo que la vista se actualice cada segundo, de repente no manda y de repente llegan 3 con segundos consecutivos". Causa raíz: el poll que refresca la bitácora/estado en Ajustes (`refreshState()`, `DeviceSettingsPanel.tsx`) corría cada **4 segundos**, no cada 1 - con el envío real pasando cada segundo, se acumulaban 3-4 entradas nuevas entre cada refresco y aparecían todas de golpe, seguidas de un silencio visual de varios segundos. Los timestamps de las entradas ya eran consecutivos (el envío real siempre estuvo bien) - era puramente la cadencia con la que la pantalla se actualizaba, no el envío en sí.

**Fix**: el poll bajó a 1 segundo. Solo corre mientras la pantalla de Ajustes está abierta (se cancela al salir), así que no es un costo de batería permanente - es una pantalla de diagnóstico que un técnico abre a propósito, no algo que corre en segundo plano todo el tiempo.

## Bug real: `413 Content Too Large` al importar KML/GeoJSON grande

No relacionado con la app Android, pero reportado en la misma ronda - **no era un límite de Google ni del navegador**, como parecía por el mensaje de Chrome. `express.json()` en el backend (`app.ts`) no tenía límite explícito, así que usaba el default de Express: **100kb**. Un KML real de ~100KB en crudo, envuelto en JSON (que infla el tamaño por el escapado de comillas/saltos de línea), pasaba justo ese límite. Subido a `20mb` - **verificado con Docker real y el KML real del usuario** (`files/TEST-FILES/Alcaraces/POLIGONOSNEW.kml`, ~108KB, 13 geocercas): importación completa exitosa (`201`), datos de prueba limpiados después.

## Limitaciones conocidas (honestas)

- El RTK/NTRIP corre mientras la app está viva - no es un servicio 100% independiente de la actividad (a diferencia de Traccar, que ya corre en un foreground service real con wakelock). Para el caso de uso real (tableta con pantalla encendida en la máquina durante el turno) no debería notarse.
- Esta app siempre usa el `LocationManager` nativo de Android para GPS, nunca Google Play Services Fused Location - a propósito, para no sumar esa dependencia pesada. Si algún día se necesita de verdad la variante Fused (mejor precisión en interiores/con GPS débil), es una tarea aparte concreta.
- El buffer sin conexión ahora vive en SQLite (`OfflineBufferStore.kt`, no un JSON en SharedPreferences) con tope de seguridad de 200,000 puntos (a 1 fix/segundo, más de dos días completos) - una desconexión de horas no pierde nada. Al reconectar, la posición EN VIVO se manda de inmediato (nunca espera al histórico) y el histórico se drena aparte con hasta 8 envíos en paralelo (el rate limit del backend es 6000/min por dispositivo, con margen de sobra) - un backlog de varias horas se pone al día en minutos, no bloquea nunca la posición actual.
- Ya probado de extremo a extremo con hardware real: receptor RTK u-blox por USB, caster NTRIP real (EarthScope), fix DGPS con 8-12 satélites, y confirmado que la posición que llega al servidor (`accuracy=2.5` en vez del ~10.5m del GPS de la tableta) es la corregida por RTK, no la del chip interno. Dos bugs reales que salieron en el proceso y ya están corregidos: faltaba activar DTR/RTS al abrir el puerto serial (el receptor no transmitía nada sin eso) y faltaba declarar `ACCESS_MOCK_LOCATION` en el manifest (sin eso la app nunca aparecía en "Seleccionar app de ubicación ficticia", sin importar reinicios ni reinstalaciones).
- El modo automático (auto-conectar USB, auto-arrancar NTRIP) todavía no se ha probado en campo con el flujo completo apagar/prender el receptor varias veces seguidas - la lógica está ahí y compilada, pero es la parte más nueva de esta ronda.

## Samsung Knox SDK (planeado, pendiente de acceso - "No Battery Mode" automático)

Hoy "No Battery Mode" se activa a mano, una sola vez por tableta (paso 7 del aprovisionamiento
adb más arriba) - no hay forma de automatizarlo con las APIs públicas de Android, es exclusivo de
Ajustes del fabricante Samsung. El camino real para automatizarlo es el **Knox Service Plugin**
(KSP, app propia de Samsung) expuesto vía `DevicePolicyManager.setApplicationRestrictions()` -el
mismo mecanismo estándar de Android Enterprise que ya usa este proyecto, dirigido al paquete de
KSP en vez de al propio - **no** un JAR/AAR del Knox SDK que haya que importar aparte.

**Bloqueado por ahora**: registrarse en el portal de desarrolladores de Samsung Knox para obtener
la llave KPE (Knox Platform for Enterprise, gratuita desde 2021/2023) requiere un correo
corporativo - el usuario no cuenta con uno todavía. Sin cuenta no hay forma de ver el nombre
exacto de la clave de configuración administrada que activa "No Battery Mode", así que no se
escribe código de integración a ciegas - mismo criterio que Firebase (deferred hasta tener las
credenciales/documentación reales en mano).

**Ya investigado y confirmado (no bloquea nada, es solo la referencia para cuando haya acceso)**:

- Desde Android 15 (Knox SDK 3.11+), Samsung exige que la app sea **Device Owner** bajo el marco
  moderno de Android Enterprise para conservar acceso a las funciones avanzadas de Knox - las apps
  que solo usan el modelo viejo de "Device Administrator" están perdiendo acceso, y Samsung planea
  seguir restringiendo más métodos en futuras versiones. Esta app **ya cumple esto** (Device Owner
  vía Android Enterprise, nunca Device Administrator puro - ver "Modo Kiosko" arriba), así que no
  hace falta ningún cambio de arquitectura cuando se integre Knox SDK.
- Página oficial de APIs obsoletas de Knox SDK:
  `https://docs.samsungknox.com/dev/knox-sdk/api-reference/deprecated-api-methods/` - política de
  1 año de soporte completo tras anunciar una obsolescencia, hasta 2 años antes de removerla del
  todo. Revisar esta página una vez que se integre cualquier API real de Knox SDK.

**Siguiente paso real**: en cuanto el usuario obtenga acceso al portal (correo corporativo) y
comparta la documentación/nombre de clave real de KSP, escribir la integración concreta - no
antes, para no repetir el error de una respuesta externa que se inventó una API de Knox SDK que no
existe tal cual (`setMinimumRequiredWifiSecurityLevel()` presentada incorrectamente como forma de
apagar WiFi, ya descartada - WiFi se apaga hoy con `WifiManager.setWifiEnabled()` estándar, exento
para Device Owner, ver sección de suspensión por pérdida de corriente arriba).
