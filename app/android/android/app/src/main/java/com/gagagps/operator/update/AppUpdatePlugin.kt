package com.gagagps.operator.update

import com.gagagps.operator.BuildConfig
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.Executors

@CapacitorPlugin(name = "AppUpdate")
class AppUpdatePlugin : Plugin() {
    private val executor = Executors.newSingleThreadExecutor()

    // apiBaseUrl+key son el mismo servidor/token ya configurados en "Servidor e identidad" (el
    // token YA es el TELEMETRY_SHARED_SECRET, ver DeviceSettingsPanel.tsx) - no una clave nueva
    @PluginMethod
    fun configure(call: PluginCall) {
        val apiBaseUrl = call.getString("apiBaseUrl") ?: ""
        val key = call.getString("key") ?: ""
        val enabled = call.getBoolean("enabled", false) ?: false
        UpdatePrefs.setServer(context, apiBaseUrl, key)
        UpdatePrefs.setEnabled(context, enabled)
        UpdateScheduler.schedule(context)
        if (enabled) {
            executor.execute { AppUpdateManager.checkAndInstall(context) }
        }
        call.resolve()
    }

    @PluginMethod
    fun checkNow(call: PluginCall) {
        executor.execute { AppUpdateManager.checkAndInstall(context) }
        call.resolve()
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        val ret = JSObject()
        ret.put("enabled", UpdatePrefs.getEnabled(context))
        ret.put("currentVersionCode", BuildConfig.VERSION_CODE)
        ret.put("currentVersionName", BuildConfig.VERSION_NAME)
        val latestCode = UpdatePrefs.getLatestVersionCode(context)
        ret.put("latestVersionCode", if (latestCode >= 0) latestCode else null)
        ret.put("latestVersionName", UpdatePrefs.getLatestVersionName(context))
        ret.put("checking", AppUpdateManager.isChecking)
        val lastCheck = UpdatePrefs.getLastCheckAt(context)
        ret.put("lastCheckAt", if (lastCheck > 0) lastCheck else null)
        ret.put("lastError", UpdatePrefs.getLastError(context))
        call.resolve(ret)
    }
}
