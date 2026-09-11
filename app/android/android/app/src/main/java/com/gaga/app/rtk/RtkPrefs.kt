package com.gaga.app.rtk

import android.content.Context

enum class NtripVersion(val key: String) {
    V1("v1"),
    V2("v2");

    companion object {
        fun fromKey(key: String?): NtripVersion = values().find { it.key == key } ?: V2
    }
}

// "ntrip" es el unico modo funcional hoy - pointperfect/usb_serial se guardan y se muestran en el
// front bloqueados "proximamente", contempladas a proposito para no rehacer el selector despues
enum class CorrectionMode(val key: String) {
    NTRIP("ntrip"),
    POINTPERFECT("pointperfect"),
    USB_SERIAL("usb_serial");

    companion object {
        fun fromKey(key: String?): CorrectionMode = values().find { it.key == key } ?: NTRIP
    }
}

object RtkPrefs {
    private const val PREFS_NAME = "gaga_rtk"

    // 460800 baudios es el default real de la mayoria de receptores RTK de gama alta con salida
    // NMEA+RTCM combinada a 5-10Hz - 115200 se queda corto y puede perder bytes en ese caso
    const val DEFAULT_BAUD_RATE = 460800
    const val DEFAULT_SW_MAPS_PORT = 11123
    const val UBLOX_VENDOR_ID = 0x1546 // 5446 decimal - USB Vendor ID oficial de u-blox

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
            version = NtripVersion.fromKey(p.getString("ntrip_version", NtripVersion.V2.key)),
        )
    }

    fun setNtripConfig(context: Context, config: NtripConfig) {
        prefs(context).edit()
            .putString("ntrip_host", config.host)
            .putInt("ntrip_port", config.port)
            .putString("ntrip_mountpoint", config.mountpoint)
            .putString("ntrip_username", config.username)
            .putString("ntrip_password", config.password)
            .putString("ntrip_version", config.version.key)
            .apply()
    }

    fun getCorrectionMode(context: Context): CorrectionMode =
        CorrectionMode.fromKey(prefs(context).getString("correction_mode", CorrectionMode.NTRIP.key))

    fun setCorrectionMode(context: Context, mode: CorrectionMode) {
        prefs(context).edit().putString("correction_mode", mode.key).apply()
    }

    fun getSwMapsPort(context: Context): Int = prefs(context).getInt("sw_maps_port", DEFAULT_SW_MAPS_PORT)
    fun setSwMapsPort(context: Context, port: Int) = prefs(context).edit().putInt("sw_maps_port", port).apply()
}
