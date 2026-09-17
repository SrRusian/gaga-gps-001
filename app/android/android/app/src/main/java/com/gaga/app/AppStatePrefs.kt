package com.gaga.app

import android.content.Context

// true mientras MainActivity esta realmente al frente (entre onResume/onPause) - usado por
// BootReceiver tras una auto-actualizacion silenciosa (ACTION_MY_PACKAGE_REPLACED) para decidir
// si debe reabrir la app o dejarla como estaba: si alguien la habia cerrado a proposito (tableta
// sin Modo Kiosko/envio continuo), debe seguir cerrada despues de actualizar; si estaba abierta
// (alguien viendola, o Kiosko/envio continuo la mantienen siempre al frente), debe reabrirse.
object AppStatePrefs {
    private const val PREFS_NAME = "gaga_app_state"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun getForeground(context: Context): Boolean = prefs(context).getBoolean("foreground", false)
    fun setForeground(context: Context, foreground: Boolean) =
        prefs(context).edit().putBoolean("foreground", foreground).apply()
}
