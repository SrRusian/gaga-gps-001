package com.gaga.app.power

import android.content.Context
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

// Puente JS <-> estado de suspension por perdida de corriente (ver PowerSuspendAlarmReceiver.kt /
// TraccarSenderService.kt). Sin esto, la suspension apagaba GPS/RTK/pantalla pero el socket del
// WebView (useOperatorSocket.ts) seguia conectado y procesando alertas/posiciones de toda la
// flota en segundo plano - bug real reportado en campo: "se apago la pantalla pero de fondo se
// estan escuchando las alertas igual". notifyChanged() avisa al WebView para que desconecte su
// propio socket mientras dure, y lo reconecte al salir - sin esto, la suspension nunca es total.
@CapacitorPlugin(name = "Power")
class PowerStatusPlugin : Plugin() {
    companion object {
        @Volatile private var instance: PowerStatusPlugin? = null

        fun notifyChanged(context: Context) {
            instance?.notifyListeners("powerStatus", statusObject(context))
        }

        private fun statusObject(context: Context): JSObject {
            val ret = JSObject()
            ret.put("suspended", PowerPrefs.getSuspended(context))
            return ret
        }
    }

    override fun load() {
        instance = this
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        call.resolve(statusObject(context))
    }
}
