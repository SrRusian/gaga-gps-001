package com.gagagps.operator.traccar

import android.content.Context
import android.location.Location
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Callable
import java.util.concurrent.Executors

data class TraccarLogEntry(
    val timestamp: Long,
    val serverUrl: String,
    val success: Boolean,
    val message: String,
)

// Logica de envio real (protocolo OsmAnd) + bitacora + buffer sin conexion - compartida entre
// TraccarSenderService (envio periodico en segundo plano) y el envio manual "Enviar ubicacion"
// del plugin. Diseño clave: la posicion EN VIVO se manda siempre de inmediato, sin esperar a que
// se vacie el historico acumulado - el drenado del buffer corre en su propio grupo de hilos,
// completamente aparte, para que un backlog de horas nunca retrase ver la posicion actual.
object TraccarUplink {
    private const val MAX_LOG_ENTRIES = 50
    private const val DRAIN_BATCH_SIZE = 40
    private const val DRAIN_PARALLELISM = 8

    private val log = ArrayDeque<TraccarLogEntry>()
    private var bufferStore: OfflineBufferStore? = null

    // pool aparte para el drenado del historico - varias peticiones HTTP en paralelo (el rate
    // limit del backend es 6000/min por dispositivo, con margen de sobra) para que un backlog de
    // horas se ponga al dia en minutos, no en un envio secuencial de uno por uno
    private val drainWorkers = Executors.newFixedThreadPool(DRAIN_PARALLELISM)
    private val drainCoordinator = Executors.newSingleThreadExecutor()

    @Volatile private var draining = false

    @Volatile var lastSentAt: Long = 0L
        private set

    @Volatile var lastError: String? = null
        private set

    private fun store(context: Context): OfflineBufferStore {
        var instance = bufferStore
        if (instance == null) {
            synchronized(this) {
                instance = bufferStore
                if (instance == null) {
                    instance = OfflineBufferStore(context)
                    bufferStore = instance
                }
            }
        }
        return instance!!
    }

    @Synchronized
    private fun addLog(entry: TraccarLogEntry) {
        log.addFirst(entry)
        while (log.size > MAX_LOG_ENTRIES) log.removeLast()
        if (entry.success) {
            lastSentAt = entry.timestamp
            lastError = null
        } else {
            lastError = "${entry.serverUrl}: ${entry.message}"
        }
    }

    @Synchronized
    fun getLogSnapshot(): List<TraccarLogEntry> = log.toList()

    // se llama por cada fix en vivo (servicio periodico) y por "Enviar ubicacion" manual
    fun sendToAllServers(context: Context, location: Location) {
        val servers = TraccarPrefs.getServers(context).filter { it.enabled }
        if (servers.isEmpty()) return

        val deviceId = TraccarPrefs.getDeviceId(context)
        val password = TraccarPrefs.getPassword(context)
        var anySuccess = false

        servers.forEach { server ->
            try {
                sendOsmAnd(server.url, deviceId, password, location)
                addLog(TraccarLogEntry(System.currentTimeMillis(), server.url, true, "OK"))
                anySuccess = true
            } catch (e: Exception) {
                addLog(TraccarLogEntry(System.currentTimeMillis(), server.url, false, e.message ?: "Error"))
                store(context).add(server.url, deviceId, password, location)
            }
        }

        // la posicion actual ya se mando (o se encolo) - el drenado del historico sigue su propio
        // camino en segundo plano, sin bloquear el siguiente fix en vivo
        if (anySuccess) triggerDrain(context)
    }

    private fun triggerDrain(context: Context) {
        if (draining) return // ya hay un drenado en curso, no lances otro en paralelo
        draining = true
        drainCoordinator.execute {
            try {
                drainLoop(context)
            } finally {
                draining = false
            }
        }
    }

    private fun drainLoop(context: Context) {
        val db = store(context)
        while (true) {
            val batch = db.peekOldest(DRAIN_BATCH_SIZE)
            if (batch.isEmpty()) return

            val futures = batch.map { item ->
                drainWorkers.submit(
                    Callable {
                        try {
                            sendOsmAnd(item.serverUrl, item.deviceId, item.password, item.location)
                            db.delete(item.rowId)
                            addLog(TraccarLogEntry(System.currentTimeMillis(), item.serverUrl, true, "OK (buffer)"))
                            true
                        } catch (e: Exception) {
                            false
                        }
                    },
                )
            }
            val allOk = futures.map { it.get() }.all { it }
            // si algo fallo, la conexion probablemente se volvio a caer - se detiene aqui y se
            // reintenta solo, en el siguiente envio en vivo exitoso
            if (!allOk) return
        }
    }

    private fun sendOsmAnd(baseUrl: String, deviceId: String, password: String, location: Location) {
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
            if (password.isNotBlank()) append("&password=").append(enc(password))
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

    fun getBufferedCount(context: Context): Int = store(context).count()
}
