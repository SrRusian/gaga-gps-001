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
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

// Servicio en primer plano: replica Traccar Client - una posición real (GPS del telefono, o el
// GPS_PROVIDER simulado por RtkNtripPlugin si el RTK esta activo, Android no distingue el origen)
// se manda por protocolo OsmAnd (GET simple) a cada servidor habilitado en TraccarPrefs.
class TraccarSenderService : Service() {
    companion object {
        const val CHANNEL_ID = "gaga_position_sender"
        const val NOTIFICATION_ID = 4210

        @Volatile var isRunning: Boolean = false
            private set

        @Volatile var lastSentAt: Long = 0L
            private set

        @Volatile var lastError: String? = null
            private set
    }

    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private lateinit var locationManager: LocationManager

    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            sendToAllServers(location)
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
        startLocationUpdates()
        isRunning = true
        return START_STICKY
    }

    override fun onDestroy() {
        try {
            locationManager.removeUpdates(listener)
        } catch (_: SecurityException) {
        }
        isRunning = false
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startLocationUpdates() {
        val intervalMs = TraccarPrefs.getIntervalMs(applicationContext)
        try {
            locationManager.requestLocationUpdates(
                LocationManager.GPS_PROVIDER,
                intervalMs,
                0f,
                listener,
            )
        } catch (e: SecurityException) {
            lastError = "Sin permiso de ubicacion"
        } catch (e: IllegalArgumentException) {
            lastError = "GPS no disponible en este dispositivo"
        }
    }

    private fun sendToAllServers(location: Location) {
        val servers = TraccarPrefs.getServers(applicationContext).filter { it.enabled }
        if (servers.isEmpty()) return
        val deviceId = TraccarPrefs.getDeviceId(applicationContext)

        servers.forEach { server ->
            scope.launch {
                try {
                    sendOsmAnd(server.url, deviceId, location)
                    lastSentAt = System.currentTimeMillis()
                    lastError = null
                } catch (e: Exception) {
                    lastError = "${server.url}: ${e.message}"
                }
            }
        }
    }

    // protocolo OsmAnd - el mismo que usa Traccar Client por defecto contra cualquier servidor Traccar
    private fun sendOsmAnd(baseUrl: String, deviceId: String, location: Location) {
        fun enc(v: String) = URLEncoder.encode(v, "UTF-8")
        val sep = if (baseUrl.contains("?")) "&" else "?"
        val query = buildString {
            append("id=").append(enc(deviceId))
            append("&timestamp=").append(location.time / 1000)
            append("&lat=").append(location.latitude)
            append("&lon=").append(location.longitude)
            if (location.hasSpeed()) append("&speed=").append(location.speed * 1.94384) // m/s a nudos
            if (location.hasBearing()) append("&bearing=").append(location.bearing)
            if (location.hasAltitude()) append("&altitude=").append(location.altitude)
            if (location.hasAccuracy()) append("&accuracy=").append(location.accuracy)
        }
        val url = URL("$baseUrl$sep$query")
        val conn = url.openConnection() as HttpURLConnection
        conn.connectTimeout = 5000
        conn.readTimeout = 5000
        conn.requestMethod = "GET"
        try {
            val code = conn.responseCode
            if (code !in 200..299) throw Exception("HTTP $code")
        } finally {
            conn.disconnect()
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
