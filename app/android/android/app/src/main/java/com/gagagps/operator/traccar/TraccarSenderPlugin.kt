package com.gagagps.operator.traccar

import android.Manifest
import android.content.Intent
import android.location.LocationManager
import android.os.Build
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.util.UUID

// Puente JS <-> TraccarSenderService/TraccarUplink. La configuracion vive en TraccarPrefs, el
// envio real (periodico y manual) en TraccarUplink - este plugin es solo control + lectura de estado.
@CapacitorPlugin(
    name = "TraccarSender",
    permissions = [
        Permission(strings = [Manifest.permission.ACCESS_FINE_LOCATION], alias = "location"),
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications"),
    ],
)
class TraccarSenderPlugin : Plugin() {

    @PluginMethod
    fun getServers(call: PluginCall) {
        val servers = TraccarPrefs.getServers(context)
        val arr = JSArray()
        servers.forEach {
            arr.put(JSObject().put("id", it.id).put("url", it.url).put("enabled", it.enabled))
        }
        val ret = JSObject()
        ret.put("servers", arr)
        call.resolve(ret)
    }

    @PluginMethod
    fun saveServers(call: PluginCall) {
        val input = call.getArray("servers") ?: JSArray()
        val servers = (0 until input.length()).map { i ->
            val o = input.getJSONObject(i)
            val id = o.optString("id").ifBlank { UUID.randomUUID().toString() }
            TraccarServer(id, o.getString("url"), o.optBoolean("enabled", true))
        }
        TraccarPrefs.setServers(context, servers)
        call.resolve()
    }

    @PluginMethod
    fun setDeviceId(call: PluginCall) {
        val deviceId = call.getString("deviceId") ?: return call.reject("deviceId requerido")
        TraccarPrefs.setDeviceId(context, deviceId)
        call.resolve()
    }

    @PluginMethod
    fun getSendSettings(call: PluginCall) {
        call.resolve(buildSendSettings())
    }

    @PluginMethod
    fun setSendSettings(call: PluginCall) {
        call.getInt("intervalSeconds")?.let { TraccarPrefs.setIntervalMs(context, it * 1000L) }
        call.getString("password")?.let { TraccarPrefs.setPassword(context, it) }
        call.resolve()
    }

    @PluginMethod
    fun resetSendSettings(call: PluginCall) {
        TraccarPrefs.resetSendingDefaults(context)
        call.resolve(buildSendSettings())
    }

    private fun buildSendSettings(): JSObject {
        return JSObject()
            .put("intervalSeconds", (TraccarPrefs.getIntervalMs(context) / 1000).toInt())
            .put("password", TraccarPrefs.getPassword(context))
    }

    @PluginMethod
    fun start(call: PluginCall) {
        val neededPermissions = mutableListOf("location")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) neededPermissions.add("notifications")

        if (!hasRequiredPermissions()) {
            requestPermissionForAliases(neededPermissions.toTypedArray(), call, "startPermissionCallback")
            return
        }
        startService(call)
    }

    @PermissionCallback
    private fun startPermissionCallback(call: PluginCall) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            call.reject("Permiso de ubicacion denegado")
            return
        }
        startService(call)
    }

    private fun startService(call: PluginCall) {
        val intent = Intent(context, TraccarSenderService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
        // "se quiere estar enviando" queda guardado - MainActivity/BootReceiver lo retoman solos
        // la proxima vez que arranque el proceso, sin que alguien vuelva a entrar a la app
        TraccarPrefs.setAutoStart(context, true)
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        context.stopService(Intent(context, TraccarSenderService::class.java))
        TraccarPrefs.setAutoStart(context, false)
        call.resolve()
    }

    // "Enviar ubicacion" manual - funciona aunque el envio continuo este apagado, igual que en
    // Traccar Client (util para probar conectividad/servidor sin activar el seguimiento)
    @PluginMethod
    fun sendNow(call: PluginCall) {
        val locationManager = context.getSystemService(android.content.Context.LOCATION_SERVICE) as LocationManager
        val location = try {
            locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                ?: locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
        } catch (e: SecurityException) {
            return call.reject("Permiso de ubicacion denegado")
        }
        if (location == null) {
            call.reject("Sin una ubicacion reciente disponible todavia")
            return
        }
        if (TraccarPrefs.getServers(context).none { it.enabled }) {
            call.reject("No hay ningun servidor activo configurado")
            return
        }
        TraccarUplink.sendToAllServers(context, location)
        call.resolve(buildStateObject())
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        call.resolve(buildStateObject())
    }

    @PluginMethod
    fun getLog(call: PluginCall) {
        val arr = JSArray()
        TraccarUplink.getLogSnapshot().forEach {
            arr.put(
                JSObject()
                    .put("timestamp", it.timestamp)
                    .put("serverUrl", it.serverUrl)
                    .put("success", it.success)
                    .put("message", it.message),
            )
        }
        val ret = JSObject()
        ret.put("entries", arr)
        call.resolve(ret)
    }

    private fun buildStateObject(): JSObject {
        val ret = JSObject()
        ret.put("running", TraccarSenderService.isRunning)
        ret.put("lastSentAt", TraccarUplink.lastSentAt)
        ret.put("lastError", TraccarUplink.lastError)
        ret.put("bufferedCount", TraccarUplink.getBufferedCount(context))
        return ret
    }
}
