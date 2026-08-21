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

// estado persistido del emisor - lista de servidores + id de dispositivo + intervalo, igual que
// Traccar Client (varios servidores simultáneos, cada uno se puede prender/apagar sin borrar)
object TraccarPrefs {
    private const val PREFS_NAME = "gaga_traccar_sender"
    private const val KEY_SERVERS = "servers"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_INTERVAL_MS = "interval_ms"
    const val DEFAULT_INTERVAL_MS = 5000L

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

    fun getIntervalMs(context: Context): Long =
        prefs(context).getLong(KEY_INTERVAL_MS, DEFAULT_INTERVAL_MS)

    fun setIntervalMs(context: Context, intervalMs: Long) {
        prefs(context).edit().putLong(KEY_INTERVAL_MS, intervalMs).apply()
    }
}
