package com.gaga.app.traccar

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.gaga.app.MainActivity
import com.gaga.app.kiosk.KioskManager
import com.gaga.app.kiosk.KioskPrefs
import com.gaga.app.power.PowerEventReporter
import com.gaga.app.power.PowerPrefs
import com.gaga.app.power.PowerStatusPlugin
import com.gaga.app.power.PowerSuspendScheduler
import com.gaga.app.rtk.RtkNtripPlugin
import com.gaga.app.update.FCMService
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

// Servicio en primer plano: replica Traccar Client - lee posicion real por GPS (GPS_PROVIDER,
// siempre - es la unica opcion realmente buena, no se ofrece "precision baja" porque solo seria
// peor) y manda cada `intervalMs` configurado, sin condiciones extra. El envio en si
// (TraccarUplink, con buffer sin conexion siempre activo) es compartido con "Enviar ubicacion" manual.
class TraccarSenderService : Service() {
    companion object {
        const val CHANNEL_ID = "gaga_position_sender"
        const val NOTIFICATION_ID = 4210

        // margen para aceptar un fix que llega apenas antes de cumplirse el intervalo - ver
        // sendLocation(). Mas chico que el jitter tipico del chip y muy lejos de permitir un envio
        // de mas: con el intervalo por default (1s) el espaciado minimo real queda en 850ms.
        private const val SEND_INTERVAL_TOLERANCE_MS = 150L

        @Volatile var isRunning: Boolean = false
            private set

        @Volatile private var runningInstance: TraccarSenderService? = null

        // MockLocationFeeder.addTestProvider()/removeTestProvider() (RtkNtripPlugin) reemplaza el
        // GPS_PROVIDER real por uno de prueba (o viceversa) - Android no conserva los
        // LocationListener ya registrados contra el proveedor anterior al hacer ese cambio, asi
        // que el envio continuo se quedaba "mudo" (sin error visible) cada vez que RTK activaba o
        // desactivaba la ubicacion simulada despues de que este servicio ya estuviera escuchando -
        // bug real reportado en campo, coincide con el patron "solo Enviar ubicacion manual
        // funciona" ya visto antes. Reabrir la app disparaba un registro nuevo (por eso "arreglaba"
        // el sintoma) sin que nadie entendiera por que. Fix: quien cambia el proveedor avisa aqui
        // para que el listener se vuelva a registrar de inmediato, sin esperar a un reinicio.
        fun reregisterLocationListener() {
            runningInstance?.startLocationUpdates(force = true)
        }

        // suspension por perdida de corriente (ver power/PowerSuspendAlarmReceiver.kt) - deja de
        // pedir ubicacion (GPS real o simulada, lo que este activo) pero el servicio en primer
        // plano sigue vivo, para poder seguir escuchando el cable/pantalla sin que Android mate
        // el proceso. No confundir con onDestroy() - ahi si se apaga todo por completo.
        fun suspendGps() {
            runningInstance?.let { instance ->
                try {
                    instance.locationManager.removeUpdates(instance.listener)
                } catch (_: SecurityException) {
                }
                instance.registeredIntervalMs = -1L
                // aqui SI se suelta el wake lock de verdad (a diferencia del envio activo normal,
                // ver comentario junto a sendWakeLock) - la suspension por perdida de corriente es
                // justo el caso donde el ahorro de bateria si importa de verdad (tableta sin
                // corriente del vehiculo)
                instance.sendWakeLock?.let { if (it.isHeld) it.release() }
            }
        }

        fun resumeGps() {
            runningInstance?.startLocationUpdates(force = true)
        }
    }

    private lateinit var locationManager: LocationManager

    // Bug real reportado en campo (ronda posterior a la optimizacion de abajo, confirmado con
    // logcat real - GnssLocationProvider entregando un fix real cada 1s exacto a nivel de chip,
    // pero la app solo llegaba a mandar cada ~4s): con el wake lock acotado solo al momento de
    // cada envio, el CPU podia volver a dormir entre un fix y el siguiente - Android agrupaba la
    // entrega del callback de ubicacion a su propio ritmo en vez de despertar exacto cada
    // segundo, aunque el chip GPS si producia un fix por segundo real. Pedido explicito: 1
    // peticion por segundo al servidor es un requisito duro, no negociable por bateria - se
    // revierte a mantener el wake lock TODO el tiempo que el envio continuo este activo (no solo
    // durante cada envio individual). Impacto de bateria aceptado a proposito: mientras el envio
    // continuo esta activo, la tableta esta operando con corriente del vehiculo de todas formas -
    // el ahorro de bateria real ya lo cubre por completo el sistema de suspension por perdida de
    // corriente (ver PowerSuspendAlarmReceiver.kt), que SI suelta este wake lock (ver suspendGps()
    // arriba). No hay timeout aqui a proposito - se suelta explicitamente en suspendGps()/onDestroy().
    private var sendWakeLock: PowerManager.WakeLock? = null
    private var lastSentAtMs: Long = 0L
    private var registeredIntervalMs: Long = -1L

    // requestLocationUpdates() sin un Looper propio entrega onLocationChanged en el hilo principal
    // - Android prohibe hacer red ahi (NetworkOnMainThreadException), por eso el envio real se
    // manda a este hilo aparte (mismo motivo por el que el envio manual del plugin si funcionaba:
    // Capacitor ya despacha los @PluginMethod fuera del hilo principal por su cuenta)
    private val ioExecutor: ExecutorService = Executors.newSingleThreadExecutor()

    // si el intervalo cambia desde Ajustes mientras el servicio ya esta corriendo, se vuelve a
    // pedir la ubicacion con el nuevo intervalo de inmediato - sin esto, un cambio de intervalo
    // solo aplicaria hasta el siguiente reinicio del servicio
    private val prefsListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == TraccarPrefs.KEY_INTERVAL_MS) startLocationUpdates()
    }

    // energia del vehiculo (cable/cargador), no la bateria de la tableta - ACTION_POWER_CONNECTED
    // es el unico dato real de "el vehiculo sigue encendido". Toda la suspension queda gateada a
    // Modo Kiosko activado (pedido explicito) - una tableta sin kiosko (de prueba, de oficina)
    // funciona normal sin limitaciones aunque se quede sin cargador. Con Kiosko activado, la
    // UNICA forma de SALIR de la suspension de verdad es que vuelva la corriente - a proposito
    // (pedido explicito: con Kiosko activo la tableta no se debe manipular para nada; si alguien
    // la necesita usar sin corriente, primero debe desactivar el Kiosko desde Ajustes con la
    // contrasena). ACTION_SCREEN_ON de aqui abajo NO reactiva nada - solo re-bloquea la pantalla
    // que el boton fisico de encendido pudo haber prendido por hardware (ver comentario en el
    // case de abajo), asi que sigue sin existir ninguna forma util de despertarla por interaccion.
    private val powerReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_POWER_DISCONNECTED -> {
                    // diagnostico del bug real reportado (tarda 26s en vez de 15) - confirma si
                    // Android ya tardo en avisarnos del cable desconectado (algunos dispositivos
                    // hacen debounce del estado de bateria unos segundos antes de emitir esto) o
                    // si el retraso esta despues, en la alarma (ver PowerSuspendScheduler)
                    android.util.Log.i("TraccarSender", "ACTION_POWER_DISCONNECTED recibido en ${android.os.SystemClock.elapsedRealtime()}")
                    if (KioskPrefs.getEnabled(applicationContext)) {
                        PowerSuspendScheduler.schedule(applicationContext)
                    }
                }
                Intent.ACTION_POWER_CONNECTED -> {
                    PowerSuspendScheduler.cancel(applicationContext)
                    if (PowerPrefs.getSuspended(applicationContext)) exitSuspension()
                }
                // limite real de Android: ningun API publica, ni Device Owner, puede evitar que el
                // boton fisico de encendido prenda la pantalla por hardware - bug real reportado
                // en campo ("sigue siendo posible encenderla presionando algun boton"). Mientras
                // dure la suspension, cualquier encendido de pantalla se vuelve a bloquear de
                // inmediato via el punto CENTRAL (KioskManager.enforcePhysicalLockIfSuspended,
                // mismo que usa MainActivity.onResume() para el boton Home) - el boton sigue
                // "funcionando" pero la pantalla parpadea y se re-bloquea sola, no queda forma
                // util de manipular la app.
                Intent.ACTION_SCREEN_ON -> {
                    KioskManager.enforcePhysicalLockIfSuspended(applicationContext)
                }
                // caso opuesto: Modo Kiosko activado y la tableta NO esta en suspension legitima
                // (pedido explicito: bloquear tambien el boton de encendido/apagado con la
                // pantalla prendida, para que nadie pueda apagarla a mano). Android no deja
                // consumir el boton de encendido en si (limite real, ver KioskManager) - se
                // revierte de inmediato apenas se detecta el apagon, reusando el mismo mecanismo
                // que ya trae la app de vuelta al recuperar la corriente.
                Intent.ACTION_SCREEN_OFF -> {
                    if (KioskManager.shouldForceScreenBackOn(applicationContext)) {
                        wakeScreenAndReopenApp()
                    }
                }
            }
        }
    }

    // unica salida de la suspension: volvio la corriente. Reenciende WiFi primero (todo lo demas
    // que reporta al backend necesita red), reanuda GPS/RTK, enciende pantalla, avisa al backend
    // y al WebView
    private fun exitSuspension() {
        PowerPrefs.setSuspended(applicationContext, false)
        try {
            val wifiManager = getSystemService(WIFI_SERVICE) as android.net.wifi.WifiManager
            @Suppress("DEPRECATION")
            wifiManager.isWifiEnabled = true
        } catch (_: Exception) {
        }
        resumeGps()
        RtkNtripPlugin.resume()
        wakeScreenAndReopenApp()
        // avisa al WebView para que reconecte su propio socket (ver PowerStatusPlugin.kt) -
        // simetrico al aviso que se manda al entrar en suspension
        PowerStatusPlugin.notifyChanged(applicationContext)
        ioExecutor.execute { PowerEventReporter.reportPowerRestored(applicationContext) }
    }

    // enciende la pantalla (WakeLock corto, solo para el "encendido" en si - MainActivity ya se
    // encarga de mantenerla encendida/brillante una vez al frente) y trae la app de vuelta -
    // KioskManager.lockScreenNow() la habia apagado al entrar en suspension. Sin bloqueo de
    // pantalla real configurado (ver README), no deberia pedir ningun codigo para volver a entrar.
    private fun wakeScreenAndReopenApp() {
        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        @Suppress("DEPRECATION")
        val wakeLock = powerManager.newWakeLock(
            PowerManager.FULL_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
            "gaga:power-restored-wake",
        )
        wakeLock.acquire(10_000L)
        val launchIntent = Intent(applicationContext, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        applicationContext.startActivity(launchIntent)
    }

    // El respaldo por NETWORK_PROVIDER se ELIMINO (18 sep). Se agrego el 17 sep para cubrir
    // "GPS sin satelites por minutos dentro de un vehiculo techado", y en dos salidas de campo
    // seguidas nunca produjo una sola posicion util - solo daño:
    //   17 sep: inundo el historial con 18,181 posiciones de antena celular (accuracy=100), que
    //           al saltar de antena generaron 393 km/h falsos, alertas e infracciones falsas.
    //   18 sep: peor - ESTARVABA AL GPS. Medido en produccion: el GPS entrego un fix a las
    //           20:20:00 y se callo el viaje entero; de ahi en adelante llegaron posiciones
    //           EXACTAMENTE cada 20s (el periodo de gracia del respaldo), sin Doppler, con
    //           precision de 24 a 130m. 603 posiciones en 110 minutos (9% de lo esperado) y 6,248
    //           segundos sin datos. Una vez que arrancaba, el circulo se sostenia solo: el
    //           respaldo interfiere con la entrega del GPS (misma interferencia ya documentada
    //           cuando se probo NETWORK_PROVIDER continuo), el GPS seguia callado, y el respaldo
    //           volvia a disparar. Solo se rompia con un requestLocationUpdates nuevo (al volver
    //           la corriente). Consecuencias en cadena: recorrido que no sigue la calle, velocidad
    //           guardada de 2.2 km/h en todo el viaje (el servidor nunca supo que iba a 92),
    //           ninguna alerta de exceso posible, 125 alertas de señal perdida y 23 paradas
    //           preventivas. Ademas seguia corriendo durante la suspension por perdida de
    //           corriente (suspendGps() nunca lo paraba), mandando cada 20s con el vehiculo
    //           apagado y la pantalla muerta - por eso la tableta seguia "En linea".
    // Sin red no se manda nada, que es lo correcto en un sistema de seguridad: una posicion
    // equivocada es peor que ninguna, y para "no se donde esta" ya existe la alerta de señal
    // perdida y el buffer sin conexion. No reintroducir sin evidencia real de que hace falta.

    private fun sendLocation(location: Location, now: Long) {
        // La tolerancia NO es cosmetica: sin ella se perdia ~35% de la telemetria. El chip entrega
        // un fix cada ~1000ms con jitter, y comparar contra el intervalo exacto hacia que un fix
        // llegado a los 999ms se descartara - el siguiente ya caia a los ~2000ms del ultimo envio.
        // Medido en produccion con datos reales: 48% de los envios a 1s y 52% a 2s, nada
        // intermedio (firma inconfundible de un throttle, no del GPS), o sea ~39 posiciones/min en
        // vez de 60. Con margen, un fix que llega un pelo antes de tiempo si se manda.
        val intervalMs = TraccarPrefs.getIntervalMs(applicationContext)
        if (now - lastSentAtMs < intervalMs - SEND_INTERVAL_TOLERANCE_MS) return
        lastSentAtMs = now
        // mismo fix exacto que se manda al servidor, reflejado de inmediato al propio WebView (ver
        // RtkNtripPlugin.emitGpsFix) - bug real reportado en campo: el marcador propio del Operador
        // (navigator.geolocation) y lo que Admin/Supervisor veian desde el servidor no coincidian
        RtkNtripPlugin.emitGpsFix(location)
        // el wake lock ya esta sostenido de forma continua mientras el envio esta activo (ver
        // comentario junto a sendWakeLock arriba) - ya no se adquiere/suelta por cada envio
        // individual, eso era justo lo que dejaba dormir al CPU entre un fix y el siguiente
        ioExecutor.execute {
            TraccarUplink.sendToAllServers(applicationContext, location)
        }
    }

    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            sendLocation(location, System.currentTimeMillis())
        }
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    override fun onCreate() {
        super.onCreate()
        locationManager = getSystemService(LOCATION_SERVICE) as LocationManager
        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        sendWakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gaga:traccar-send").apply {
            setReferenceCounted(false)
        }
        createChannel()
        getSharedPreferences(TraccarPrefs.PREFS_NAME, MODE_PRIVATE)
            .registerOnSharedPreferenceChangeListener(prefsListener)
        val powerFilter = IntentFilter().apply {
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
            // ACTION_SCREEN_ON/OFF solo se entregan a un receiver registrado en runtime (no
            // funcionan declarados en el manifest) - por eso van en este mismo receiver, ya
            // registrado en runtime aqui abajo
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(powerReceiver, powerFilter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(powerReceiver, powerFilter)
        }
        // registra/actualiza el token FCM de esta tableta en el backend - ademas de
        // FCMService.onNewToken() (solo dispara en la primera instalacion o al rotar el token de
        // verdad), practica recomendada por la propia documentacion de Firebase. No-op silencioso
        // si google-services.json no esta presente en este build (try/catch dentro de la funcion).
        FCMService.requestAndReportCurrentToken(applicationContext)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat()
        runningInstance = this
        startLocationUpdates()
        isRunning = true
        return START_STICKY
    }

    override fun onDestroy() {
        try {
            locationManager.removeUpdates(listener)
        } catch (_: SecurityException) {
        }
        getSharedPreferences(TraccarPrefs.PREFS_NAME, MODE_PRIVATE)
            .unregisterOnSharedPreferenceChangeListener(prefsListener)
        try {
            unregisterReceiver(powerReceiver)
        } catch (_: IllegalArgumentException) {
        }
        ioExecutor.shutdownNow()
        sendWakeLock?.let { if (it.isHeld) it.release() }
        sendWakeLock = null
        isRunning = false
        if (runningInstance === this) runningInstance = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // pide fixes al ritmo del intervalo de envio configurado (no "cada fix posible") - deja que el
    // chip GNSS descanse entre fixes en vez de calcular posicion sin parar para descartar casi
    // todas en el listener. A 1s (default) no cambia nada perceptible; en un intervalo mayor
    // (tableta en reposo, probando otro valor) es la diferencia real entre GPS siempre encendido
    // y GPS duty-cycled. Se vuelve a llamar si el intervalo cambia en caliente (ver prefsListener).
    private fun startLocationUpdates(force: Boolean = false) {
        val intervalMs = TraccarPrefs.getIntervalMs(applicationContext)
        if (!force && intervalMs == registeredIntervalMs) return
        try {
            locationManager.removeUpdates(listener)
        } catch (_: SecurityException) {
        }
        try {
            // El Looper EXPLICITO no es opcional. La variante de 4 argumentos ata el listener al
            // Looper del hilo que llama, y reregisterLocationListener() se invoca desde el hilo del
            // USB (MockLocationFeeder.feed() <- onDataReceived del receptor RTK). Ese hilo tiene un
            // Looper preparado pero NUNCA se le corre loop(), asi que el listener quedaba
            // registrado contra una cola de mensajes que nadie vacia: onLocationChanged no volvia a
            // dispararse jamas y la tableta dejaba de mandar posicion en silencio, con el servicio
            // vivo y el switch de "envio continuo" en azul. Bug real de campo del 19 sep: 2 horas
            // de viaje sin una sola posicion, y se arreglaba solo apagando y prendiendo el switch
            // (eso re-registraba desde el hilo principal). Con el Looper explicito, da igual quien
            // llame: la entrega siempre ocurre en el hilo principal.
            locationManager.requestLocationUpdates(
                LocationManager.GPS_PROVIDER,
                intervalMs,
                0f,
                listener,
                Looper.getMainLooper(),
            )
            registeredIntervalMs = intervalMs
            // mantiene el CPU despierto mientras el envio continuo este activo (ver comentario
            // junto a sendWakeLock) - acquire() sin timeout aqui es intencional, se suelta
            // explicitamente en suspendGps()/onDestroy(), no por si solo. setReferenceCounted(false)
            // (ver onCreate) hace que llamar acquire() de nuevo aqui, aunque ya estuviera sostenido,
            // sea seguro - nunca se apila.
            sendWakeLock?.acquire()
        } catch (e: SecurityException) {
            android.util.Log.w("TraccarSender", "Sin permiso de ubicacion")
        } catch (e: IllegalArgumentException) {
            android.util.Log.w("TraccarSender", "GPS no disponible en este dispositivo")
        }
        // GPS_PROVIDER es la UNICA fuente a proposito - ver el bloque de arriba sobre por que se
        // elimino el respaldo por NETWORK_PROVIDER.
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Envio de posicion",
                NotificationManager.IMPORTANCE_LOW,
            )
            manager.createNotificationChannel(channel)
        }
    }

    private fun startForegroundCompat() {
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("GAGA Operador")
            .setContentText("Enviando posicion al servidor")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }
}
