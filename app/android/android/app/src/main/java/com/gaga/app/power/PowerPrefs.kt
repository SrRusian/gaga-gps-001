package com.gaga.app.power

import android.content.Context
import android.net.wifi.WifiManager

object PowerPrefs {
    private const val PREFS_NAME = "gaga_power_state"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    // true mientras la tableta esta en suspension profunda por perdida de corriente - GPS/RTK/envio
    // apagados, solo escuchando el cable (ver PowerSuspendAlarmReceiver.kt) - la unica salida es
    // que vuelva la corriente, sin reactivacion por tocar la pantalla
    fun getSuspended(context: Context): Boolean = prefs(context).getBoolean("suspended", false)
    fun setSuspended(context: Context, suspended: Boolean) =
        prefs(context).edit().putBoolean("suspended", suspended).apply()

    // apaga WiFi de nuevo si la tableta SIGUE suspendida - usado despues de la revision de
    // actualizacion de las 2 AM que tuvo que encenderlo temporalmente para tener red
    // (update/AppUpdateManager.kt), y como respaldo en BootReceiver por si el proceso se mato a
    // mitad de esa revision antes de llegar a su propio paso de apagarlo. No-op si ya no esta
    // suspendida (volvio la corriente durante la revision - exitSuspension() ya dejo WiFi
    // encendido de verdad, no hay que tocarlo).
    fun disableWifiIfStillSuspended(context: Context) {
        if (!getSuspended(context)) return
        try {
            val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            wifiManager.isWifiEnabled = false
        } catch (_: Exception) {
        }
    }
}
