package com.gagagps.operator.traccar

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

// un servidor de destino estilo Traccar Client - url base (http://host:puerto/protocolo_osmand)
data class TraccarServer(
    val id: String,
    val url: String,
    val enabled: Boolean,
)

// estado persistido del emisor - deliberadamente minimo: GPS y buffer/wakelock siempre estan
// forzados al mejor modo posible en el codigo (ver TraccarSenderService/TraccarUplink), no hay
// ajustes de "precision baja" ni "sin buffer" que solo empeorarian el sistema - lo unico realmente
// util de tocar en campo es el intervalo (para pruebas) y la contrasena (si el servidor la exige)
object TraccarPrefs {
    const val PREFS_NAME = "gaga_traccar_sender"
    private const val KEY_SERVERS = "servers"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_PASSWORD = "password"
    private const val KEY_INTERVAL_MS = "interval_ms"
    private const val KEY_AUTO_START = "auto_start"

    const val DEFAULT_INTERVAL_MS = 1000L

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun getServers(context: Context): List<TraccarServer> {
        val raw = prefs(context).getString(KEY_SERVERS, null) ?: return emptyList()
        val arr = JSONArray(raw)
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            TraccarServer(o.getString("id"), o.getString("url"), o.optBoolean("enabled", true))
        }
    }

    fun setServers(context: Context, servers: List<TraccarServer>) {
        val arr = JSONArray()
        servers.forEach {
            arr.put(
                JSONObject()
                    .put("id", it.id)
                    .put("url", it.url)
                    .put("enabled", it.enabled),
            )
        }
        prefs(context).edit().putString(KEY_SERVERS, arr.toString()).apply()
    }

    fun getDeviceId(context: Context): String =
        prefs(context).getString(KEY_DEVICE_ID, null) ?: android.os.Build.MODEL

    fun setDeviceId(context: Context, deviceId: String) {
        prefs(context).edit().putString(KEY_DEVICE_ID, deviceId).apply()
    }

    fun getPassword(context: Context): String = prefs(context).getString(KEY_PASSWORD, "") ?: ""

    fun setPassword(context: Context, password: String) {
        prefs(context).edit().putString(KEY_PASSWORD, password).apply()
    }

    fun getIntervalMs(context: Context): Long =
        prefs(context).getLong(KEY_INTERVAL_MS, DEFAULT_INTERVAL_MS)

    fun setIntervalMs(context: Context, intervalMs: Long) {
        prefs(context).edit().putLong(KEY_INTERVAL_MS, intervalMs).apply()
    }

    // restaura solo el intervalo - nunca toca servidor/token/deviceId/password/lista de servidores
    fun resetSendingDefaults(context: Context) {
        setIntervalMs(context, DEFAULT_INTERVAL_MS)
    }

    // "se quiere estar enviando" - independiente de si el servicio esta corriendo AHORA MISMO.
    // Se guarda en true al presionar iniciar (por el usuario o el modo automatico) y en false al
    // detener explicitamente - MainActivity y BootReceiver lo leen para retomar el envio solos
    // sin que alguien tenga que volver a entrar a la app y darle "Iniciar" cada vez.
    fun getAutoStart(context: Context): Boolean = prefs(context).getBoolean(KEY_AUTO_START, false)

    fun setAutoStart(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_AUTO_START, enabled).apply()
    }
}
