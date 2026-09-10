package com.gagagps.operator.kiosk

import android.content.Context

// "Modo Kiosko" activado desde Ajustes (protegido por la contrasena de ajustes ya existente) -
// mismo patron que RtkPrefs/TraccarPrefs. Se lee en MainActivity.onCreate() para reentrar al
// kiosko solo (Lock Task Mode no sobrevive un reinicio del proceso por su cuenta).
object KioskPrefs {
    private const val PREFS_NAME = "gaga_kiosk"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun getEnabled(context: Context): Boolean = prefs(context).getBoolean("enabled", false)
    fun setEnabled(context: Context, enabled: Boolean) = prefs(context).edit().putBoolean("enabled", enabled).apply()
}
