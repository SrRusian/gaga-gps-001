package com.gaga.app.update

import android.content.Context

object UpdatePrefs {
    private const val PREFS_NAME = "gaga_app_update"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun getEnabled(context: Context): Boolean = prefs(context).getBoolean("enabled", false)
    fun setEnabled(context: Context, enabled: Boolean) = prefs(context).edit().putBoolean("enabled", enabled).apply()

    fun getApiBaseUrl(context: Context): String = prefs(context).getString("api_base_url", "") ?: ""
    fun getKey(context: Context): String = prefs(context).getString("key", "") ?: ""

    fun setServer(context: Context, apiBaseUrl: String, key: String) {
        prefs(context).edit()
            .putString("api_base_url", apiBaseUrl)
            .putString("key", key)
            .apply()
    }

    fun getLastCheckAt(context: Context): Long = prefs(context).getLong("last_check_at", 0L)
    fun setLastCheckAt(context: Context, at: Long) = prefs(context).edit().putLong("last_check_at", at).apply()

    fun getLastError(context: Context): String? = prefs(context).getString("last_error", null)
    fun setLastError(context: Context, error: String?) = prefs(context).edit().putString("last_error", error).apply()

    // ultimo manifest visto en el servidor - se guarda para que getStatus() tenga algo que
    // mostrar sin depender de una consulta de red en ese momento
    fun getLatestVersionCode(context: Context): Int = prefs(context).getInt("latest_version_code", -1)
    fun getLatestVersionName(context: Context): String? = prefs(context).getString("latest_version_name", null)

    fun setLatest(context: Context, versionCode: Int, versionName: String) {
        prefs(context).edit()
            .putInt("latest_version_code", versionCode)
            .putString("latest_version_name", versionName)
            .apply()
    }
}
