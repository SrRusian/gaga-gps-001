package com.gagagps.operator.traccar

import android.Manifest
import android.content.Intent
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

// Puente JS <-> TraccarSenderService. La lista de servidores vive en TraccarPrefs (SharedPreferences),
// el servicio en primer plano hace el envio real - este plugin solo es la capa de configuracion/control.
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
    fun setInterval(call: PluginCall) {
        val ms = call.getInt("intervalMs") ?: return call.reject("intervalMs requerido")
        TraccarPrefs.setIntervalMs(context, ms.toLong())
        call.resolve()
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
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        context.stopService(Intent(context, TraccarSenderService::class.java))
        call.resolve()
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        val ret = JSObject()
        ret.put("running", TraccarSenderService.isRunning)
        ret.put("lastSentAt", TraccarSenderService.lastSentAt)
        ret.put("lastError", TraccarSenderService.lastError)
        call.resolve(ret)
    }
}
