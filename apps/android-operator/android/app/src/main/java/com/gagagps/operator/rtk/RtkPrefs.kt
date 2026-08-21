package com.gagagps.operator.rtk

import android.content.Context

object RtkPrefs {
    private const val PREFS_NAME = "gaga_rtk"
    const val DEFAULT_BAUD_RATE = 115200

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun getBaudRate(context: Context): Int = prefs(context).getInt("baud_rate", DEFAULT_BAUD_RATE)
    fun setBaudRate(context: Context, baud: Int) = prefs(context).edit().putInt("baud_rate", baud).apply()

    fun getNtripConfig(context: Context): NtripConfig? {
        val p = prefs(context)
        val host = p.getString("ntrip_host", null) ?: return null
        return NtripConfig(
            host = host,
            port = p.getInt("ntrip_port", 2101),
            mountpoint = p.getString("ntrip_mountpoint", "") ?: "",
            username = p.getString("ntrip_username", "") ?: "",
            password = p.getString("ntrip_password", "") ?: "",
        )
    }

    fun setNtripConfig(context: Context, config: NtripConfig) {
        prefs(context).edit()
            .putString("ntrip_host", config.host)
            .putInt("ntrip_port", config.port)
            .putString("ntrip_mountpoint", config.mountpoint)
            .putString("ntrip_username", config.username)
            .putString("ntrip_password", config.password)
            .apply()
    }
}
