package com.gaga.app.traccar

import android.content.Context
import android.location.Location
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import com.gaga.app.rtk.CompassHeadingHolder
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

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

    private val log = ArrayDeque<TraccarLogEntry>()
    private var bufferStore: OfflineBufferStore? = null

    // hilo aparte para el drenado del historico, para que un backlog de horas nunca retrase el
    // envio de la posicion en vivo. Se envia de uno en uno y en orden de id (cronologico): antes
    // iban 8 en paralelo y llegaban desordenados y duplicados al servidor - confirmado en
    // produccion, el mismo punto de las 21:56:59 aparece dos veces y el de las 21:57:01 tres veces
    private val drainCoordinator = Executors.newSingleThreadExecutor()

    // AtomicBoolean y no @Volatile: el "if (draining) return; draining = true" anterior no era
    // atomico y dejaba arrancar dos drenados a la vez, reenviando los mismos puntos
    private val draining = AtomicBoolean(false)

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
        if (deviceId.isBlank()) return // sin id real configurado - nada que mandar todavia
        val password = TraccarPrefs.getPassword(context)
        var anySuccess = false

        val batteryPercent = readBatteryPercent(context)

        // sin red no se intenta el HTTP: con los datos apagados cada intento tarda hasta 5-20s en
        // fallar (la resolucion DNS no respeta connectTimeout) y la cola del executor de un solo
        // hilo crecia mas rapido de lo que drenaba, asi que la mayoria de las posiciones nunca
        // alcanzaba a escribirse en el buffer. Bug real confirmado en produccion: de ~430
        // posiciones de un corte de 7 minutos solo 38 quedaron guardadas. Encolar es instantaneo.
        if (!hasNetwork(context)) {
            servers.forEach { store(context).add(it.url, deviceId, password, location) }
            return
        }

        servers.forEach { server ->
            try {
                sendOsmAnd(server.url, deviceId, password, location, batteryPercent)
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

    // true si no se puede determinar - ante la duda se intenta enviar, nunca se encola de mas
    private fun hasNetwork(context: Context): Boolean {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return true
        val network = manager.activeNetwork ?: return false
        val caps = manager.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun triggerDrain(context: Context) {
        if (!draining.compareAndSet(false, true)) return // ya hay un drenado en curso
        drainCoordinator.execute {
            try {
                drainLoop(context)
            } finally {
                draining.set(false)
            }
        }
    }

    private fun drainLoop(context: Context) {
        val db = store(context)
        // se reenvia contra el/los servidor(es) configurados AHORA - no contra item.serverUrl (el
        // que estaba activo cuando ese punto se encolo). Bug real reportado: cambiar de servidor
        // (ej. probar una URL de prueba y volver a la real) dejaba el buffer viejo atorado para
        // siempre, reintentando contra la URL vieja que ya nadie usa, aunque el envio en vivo
        // funcionara perfecto contra la URL nueva - la cuenta de "en buffer" nunca bajaba.
        val servers = TraccarPrefs.getServers(context).filter { it.enabled }
        if (servers.isEmpty()) return
        while (true) {
            val batch = db.peekOldest(DRAIN_BATCH_SIZE)
            if (batch.isEmpty()) return

            // bateria ACTUAL, no la de cuando se encolo el punto (no se guarda en el buffer) - un
            // punto viejo reenviado con la bateria de ahora es tan razonable como cualquier otra
            // aproximacion, sin necesitar cambiar el schema de OfflineBufferStore por esto
            val batteryPercent = readBatteryPercent(context)

            // en lote y en orden cronologico (peekOldest ya ordena por id ASC): el servidor
            // reconstruye el recorrido tal cual ocurrio, sin puntos adelantandose entre si. Una
            // hora de respaldo son ~3600 puntos: de a uno serian 3600 handshakes HTTP sobre una
            // red que acaba de volver, en lotes de 40 son 90 - y el envio EN VIVO nunca espera a
            // esto, corre en su propio hilo (ver drainCoordinator).
            val ok = servers.all { server ->
                try {
                    sendOsmAndBatch(server.url, batch, batteryPercent)
                    true
                } catch (e: Exception) {
                    // servidor viejo sin /gps/batch, o fallo puntual: se reintenta de a uno para no
                    // quedarse atorado sin poder drenar nunca
                    batch.all { item ->
                        try {
                            sendOsmAnd(server.url, item.deviceId, item.password, item.location, batteryPercent)
                            true
                        } catch (e2: Exception) {
                            false
                        }
                    }
                }
            }
            // si algo fallo, la conexion probablemente se volvio a caer - se detiene aqui sin
            // borrar nada y se reintenta solo, en el siguiente envio en vivo exitoso
            if (!ok) return
            batch.forEach { db.delete(it.rowId) }
            addLog(TraccarLogEntry(System.currentTimeMillis(), servers.first().url, true, "OK (buffer x${batch.size})"))
        }
    }

    // BATTERY_PROPERTY_CAPACITY da el porcentaje 0-100 directo, sin registrar ningun receiver de
    // ACTION_BATTERY_CHANGED (mucho mas simple para una lectura puntual como esta) - null si el
    // sistema no lo reporta (algunos fabricantes/emuladores), el parametro batt simplemente se omite
    private fun readBatteryPercent(context: Context): Int? {
        val manager = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager ?: return null
        val level = manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (level in 0..100) level else null
    }

    // por debajo de esta velocidad el rumbo GPS es ruido - mismo numero que COURSE_TRUST_MIN_KMH
    // del backend y MIN_SPEED_MPS_FOR_CALIBRATION del Operador (criterio compartido, no acoplamiento)
    private const val COURSE_TRUST_MIN_MPS = 3f / 3.6f

    // un punto reenviado del buffer puede ser de hace una hora - la brujula de AHORA no dice nada
    // de hacia donde apuntaba el vehiculo entonces, asi que solo se aplica a un fix en vivo
    private const val LIVE_FIX_MAX_AGE_MS = 5_000L

    private fun resolveBearing(location: Location): Float? {
        val moving = location.hasSpeed() && location.speed >= COURSE_TRUST_MIN_MPS
        if (moving && location.hasBearing()) return location.bearing
        val isLive = System.currentTimeMillis() - location.time <= LIVE_FIX_MAX_AGE_MS
        if (isLive) CompassHeadingHolder.recent()?.let { return it }
        return if (location.hasBearing()) location.bearing else null
    }

    // el servidor guardado apunta al endpoint OsmAnd de un solo punto (.../gps?key=...) - el de
    // lote vive en .../gps/batch con la misma clave, asi que se inserta el segmento antes del query
    private fun batchUrlFor(baseUrl: String): String {
        val queryAt = baseUrl.indexOf('?')
        val path = if (queryAt >= 0) baseUrl.substring(0, queryAt) else baseUrl
        val query = if (queryAt >= 0) baseUrl.substring(queryAt) else ""
        return path.trimEnd('/') + "/batch" + query
    }

    private fun sendOsmAndBatch(
        baseUrl: String,
        items: List<BufferedPosition>,
        batteryPercent: Int?,
    ) {
        val positions = JSONArray()
        items.forEach { item ->
            val location = item.location
            val obj = JSONObject()
            obj.put("id", item.deviceId)
            obj.put("timestamp", location.time / 1000)
            obj.put("lat", location.latitude)
            obj.put("lon", location.longitude)
            if (location.hasSpeed()) obj.put("speed", location.speed * 1.94384) // m/s a nudos
            if (location.hasBearing()) obj.put("bearing", location.bearing)
            if (location.hasAltitude()) obj.put("altitude", location.altitude)
            if (location.hasAccuracy()) obj.put("accuracy", location.accuracy)
            batteryPercent?.let { obj.put("batt", it) }
            positions.put(obj)
        }
        val body = JSONObject().put("positions", positions).toString().toByteArray(Charsets.UTF_8)

        val conn = URL(batchUrlFor(baseUrl)).openConnection() as HttpURLConnection
        conn.connectTimeout = 10000
        conn.readTimeout = 20000
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        try {
            conn.outputStream.use { it.write(body) }
            val code = conn.responseCode
            if (code !in 200..299) throw Exception("HTTP $code")
        } finally {
            conn.disconnect()
        }
    }

    private fun sendOsmAnd(
        baseUrl: String,
        deviceId: String,
        password: String,
        location: Location,
        batteryPercent: Int? = null,
    ) {
        fun enc(v: String) = URLEncoder.encode(v, "UTF-8")
        val sep = if (baseUrl.contains("?")) "&" else "?"
        val query = buildString {
            append("id=").append(enc(deviceId))
            append("&timestamp=").append(location.time / 1000)
            append("&lat=").append(location.latitude)
            append("&lon=").append(location.longitude)
            if (location.hasSpeed()) append("&speed=").append(location.speed * 1.94384) // m/s a nudos
            // el rumbo GPS no es confiable a baja velocidad (mismo criterio que usa el mapa del
            // Operador y VehicleHeadingTracker del backend) - detenido se manda la brujula ya
            // calibrada, para que el servidor vea hacia donde apunta el vehiculo y no un rumbo
            // congelado de hace minutos. Si no hay brujula fresca se cae al comportamiento de antes.
            val bearing = resolveBearing(location)
            if (bearing != null) append("&bearing=").append(bearing)
            if (location.hasAltitude()) append("&altitude=").append(location.altitude)
            if (location.hasAccuracy()) append("&accuracy=").append(location.accuracy)
            batteryPercent?.let { append("&batt=").append(it) }
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
