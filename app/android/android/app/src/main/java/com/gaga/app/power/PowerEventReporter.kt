package com.gaga.app.power

import com.gaga.app.traccar.TraccarPrefs
import com.gaga.app.update.UpdatePrefs
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

// avisa al backend de un cambio de estado de energia (ver backend/src/api/routes/power-events.routes.ts)
// - mismo servidor/clave que ya usa AppUpdateManager (UpdatePrefs, sincronizado por
// DeviceSettingsPanel.applyProfile() cada vez que se guarda un perfil de servidor). Llamadas
// bloqueantes a proposito - quien las use debe hacerlo desde un hilo aparte (goAsync()+Executor,
// igual que UpdateCheckReceiver), nunca desde el hilo principal.
object PowerEventReporter {
    // true si el backend confirmo que la posicion cae dentro de una geocerca "deposito" (sin
    // alerta) - false en cualquier otro caso, incluido error de red (mejor asumir "no autorizado"
    // que silenciar una alerta real por una falla de conexion)
    fun reportPowerLost(context: android.content.Context, lat: Double, lon: Double): Boolean {
        val apiBaseUrl = UpdatePrefs.getApiBaseUrl(context).trim().trimEnd('/')
        val key = UpdatePrefs.getKey(context).trim()
        val deviceId = TraccarPrefs.getDeviceId(context).trim()
        if (apiBaseUrl.isEmpty() || key.isEmpty() || deviceId.isEmpty()) return false

        return try {
            val body = JSONObject().apply {
                put("deviceId", deviceId)
                put("lat", lat)
                put("lon", lon)
                put("key", key)
            }
            val responseBody = post(URL("$apiBaseUrl/api/power-events/power-lost"), body) ?: return false
            JSONObject(responseBody).optBoolean("authorized", false)
        } catch (_: Exception) {
            false
        }
    }

    fun reportPowerRestored(context: android.content.Context) {
        val apiBaseUrl = UpdatePrefs.getApiBaseUrl(context).trim().trimEnd('/')
        val key = UpdatePrefs.getKey(context).trim()
        val deviceId = TraccarPrefs.getDeviceId(context).trim()
        if (apiBaseUrl.isEmpty() || key.isEmpty() || deviceId.isEmpty()) return

        try {
            val body = JSONObject().apply {
                put("deviceId", deviceId)
                put("key", key)
            }
            post(URL("$apiBaseUrl/api/power-events/power-restored"), body)
        } catch (_: Exception) {
            // informativo unicamente - si falla, el proximo /gps real ya limpia la suspension
            // del lado del backend (SignalLostService.recordPosition)
        }
    }

    private fun post(url: URL, body: JSONObject): String? {
        val conn = url.openConnection() as HttpURLConnection
        conn.connectTimeout = 10000
        conn.readTimeout = 10000
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        return try {
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
            if (conn.responseCode != 200) return null
            conn.inputStream.bufferedReader().readText()
        } finally {
            conn.disconnect()
        }
    }
}
