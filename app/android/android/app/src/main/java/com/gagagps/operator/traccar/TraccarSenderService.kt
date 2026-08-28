package com.gagagps.operator.traccar

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
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

        @Volatile var isRunning: Boolean = false
            private set
    }

    private lateinit var locationManager: LocationManager
    private var wakeLock: PowerManager.WakeLock? = null
    private var lastSentAtMs: Long = 0L

    // requestLocationUpdates() sin un Looper propio entrega onLocationChanged en el hilo principal
    // - Android prohibe hacer red ahi (NetworkOnMainThreadException), por eso el envio real se
    // manda a este hilo aparte (mismo motivo por el que el envio manual del plugin si funcionaba:
    // Capacitor ya despacha los @PluginMethod fuera del hilo principal por su cuenta)
    private val ioExecutor: ExecutorService = Executors.newSingleThreadExecutor()

    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            val now = System.currentTimeMillis()
            if (now - lastSentAtMs < TraccarPrefs.getIntervalMs(applicationContext)) return
            lastSentAtMs = now
            ioExecutor.execute { TraccarUplink.sendToAllServers(applicationContext, location) }
        }
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    override fun onCreate() {
        super.onCreate()
        locationManager = getSystemService(LOCATION_SERVICE) as LocationManager
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat()
        acquireWakeLock()
        startLocationUpdates()
        isRunning = true
        return START_STICKY
    }

    override fun onDestroy() {
        try {
            locationManager.removeUpdates(listener)
        } catch (_: SecurityException) {
        }
        ioExecutor.shutdownNow()
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        isRunning = false
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // siempre activo mientras el envio corre - apagarlo solo haria el envio menos confiable con
    // pantalla apagada, sin ningun beneficio real, asi que no se ofrece como opcion
    private fun acquireWakeLock() {
        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        val lock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gaga:traccar-sender")
        lock.setReferenceCounted(false)
        lock.acquire()
        wakeLock = lock
    }

    private fun startLocationUpdates() {
        try {
            // se pide cada fix disponible (minTime/minDistance en 0) - el intervalo de ENVIO real
            // lo decide el listener arriba, no la tasa de muestreo del GPS
            locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 0L, 0f, listener)
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
