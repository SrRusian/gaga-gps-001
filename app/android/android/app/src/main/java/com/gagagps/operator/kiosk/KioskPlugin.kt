package com.gagagps.operator.kiosk

import com.gagagps.operator.MainActivity
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

// Puente JS <-> KioskManager. La decision de "quien puede activar/desactivar esto" vive del lado
// web (DeviceSettingsPanel.tsx, detras de la misma contrasena de Ajustes que ya protege el resto) -
// este plugin solo ejecuta, no valida permisos de usuario.
@CapacitorPlugin(name = "Kiosk")
class KioskPlugin : Plugin() {
    @PluginMethod
    fun getStatus(call: PluginCall) {
        val ret = JSObject()
        ret.put("isDeviceOwner", KioskManager.isDeviceOwner(context))
        ret.put("enabled", KioskPrefs.getEnabled(context))
        ret.put("active", activity?.let { KioskManager.isLockTaskActive(it) } ?: false)
        ret.put("developerOptionsEnabled", KioskManager.isDeveloperOptionsEnabled(context))
        ret.put("wasQrProvisioned", KioskPrefs.getWasQrProvisioned(context))
        call.resolve(ret)
    }

    // atajo a la pantalla de Opciones de desarrollador (o Acerca de la tableta si esa todavia no
    // esta disponible) - usado por el checklist de aprovisionamiento en Ajustes (RTK/NTRIP)
    @PluginMethod
    fun openDeveloperOptions(call: PluginCall) {
        KioskManager.openDeveloperOptionsOrAbout(context)
        call.resolve()
    }

    @PluginMethod
    fun enable(call: PluginCall) {
        if (!KioskManager.isDeviceOwner(context)) {
            return call.reject(
                "Esta tableta todavia no es Device Owner - hace falta el comando adb de " +
                    "aprovisionamiento una sola vez (ver app/android/README.md).",
            )
        }
        KioskPrefs.setEnabled(context, true)
        activity?.let { KioskManager.enterKiosk(it, MainActivity::class.java) }
        call.resolve()
    }

    @PluginMethod
    fun disable(call: PluginCall) {
        KioskPrefs.setEnabled(context, false)
        activity?.let { KioskManager.exitKiosk(it) }
        call.resolve()
    }
}
