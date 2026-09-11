package com.gaga.app.traccar

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
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

        // tope de seguridad del wake lock por envio - de sobra para el peor caso real (varios
        // servidores configurados, 5s de timeout cada uno en TraccarUplink), nunca deberia
        // alcanzarse en un envio normal
        private const val SEND_WAKE_LOCK_TIMEOUT_MS = 15_000L

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
    }

    private lateinit var locationManager: LocationManager

    // wake lock acotado a "recibi un fix, lo estoy mandando" - NO se mantiene por toda la vida del
    // servicio. Bug real corregido: la version anterior tomaba un PARTIAL_WAKE_LOCK una sola vez en
    // onStartCommand y lo soltaba hasta onDestroy, manteniendo el CPU despierto sin dormir en
    // absoluto mientras el envio estuviera activo (horas, con pantalla apagada) - un desperdicio
    // real de bateria que no aportaba nada una vez que el intervalo de GPS ya esta acotado (ver
    // startLocationUpdates). Con timeout como red de seguridad si algo se cuelga.
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

    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            val now = System.currentTimeMillis()
            if (now - lastSentAtMs < TraccarPrefs.getIntervalMs(applicationContext)) return
            lastSentAtMs = now
            sendWakeLock?.acquire(SEND_WAKE_LOCK_TIMEOUT_MS)
            ioExecutor.execute {
                try {
                    TraccarUplink.sendToAllServers(applicationContext, location)
                } finally {
                    sendWakeLock?.let { if (it.isHeld) it.release() }
                }
            }
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
            locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, intervalMs, 0f, listener)
            registeredIntervalMs = intervalMs
        } catch (e: SecurityException) {
            android.util.Log.w("TraccarSender", "Sin permiso de ubicacion")
        } catch (e: IllegalArgumentException) {
            android.util.Log.w("TraccarSender", "GPS no disponible en este dispositivo")
        }
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
