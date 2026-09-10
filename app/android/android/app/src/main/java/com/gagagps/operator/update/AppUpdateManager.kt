package com.gagagps.operator.update

import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import com.gagagps.operator.BuildConfig
import com.gagagps.operator.traccar.TraccarPrefs
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest

// revisa el servidor por una version nueva del APK (ver backend/src/api/routes/app-update.routes.ts),
// la descarga a almacenamiento privado, verifica su integridad (sha256 contra lo publicado) y solo
// entonces la instala en silencio via PackageInstaller - requiere que la app ya sea Device Owner
// (mismo aprovisionamiento que el kiosko, ver kiosk/KioskManager.kt); sin eso, Android puede pedir
// confirmacion en pantalla para instalar, o directamente rechazar el commit
object AppUpdateManager {
    @Volatile var isChecking: Boolean = false
        private set

    private fun isDeviceOwner(context: Context): Boolean {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        return dpm.isDeviceOwnerApp(context.packageName)
    }

    fun checkAndInstall(context: Context) {
        if (isChecking) return
        isChecking = true
        try {
            runCheck(context)
        } finally {
            isChecking = false
        }
    }

    private fun runCheck(context: Context) {
        val apiBaseUrl = UpdatePrefs.getApiBaseUrl(context).trim().trimEnd('/')
        val key = UpdatePrefs.getKey(context).trim()
        if (apiBaseUrl.isEmpty() || key.isEmpty()) return

        // se reporta la version instalada siempre que haya servidor configurado, sin importar el
        // switch - es solo informativo (columna "actualizado/desactualizado" en el panel), la
        // descarga/instalacion real de abajo si respeta el switch
        reportInstalledVersion(context, apiBaseUrl, key)

        if (!UpdatePrefs.getEnabled(context)) return

        try {
            val manifest = fetchLatest(apiBaseUrl, key)
            UpdatePrefs.setLatest(context, manifest.versionCode, manifest.versionName)
            UpdatePrefs.setLastCheckAt(context, System.currentTimeMillis())
            UpdatePrefs.setLastError(context, null)

            if (manifest.versionCode <= BuildConfig.VERSION_CODE) return

            if (!isDeviceOwner(context)) {
                UpdatePrefs.setLastError(context, "Version nueva disponible pero esta tableta todavia no es Device Owner - no se puede instalar en silencio")
                return
            }

            val apkFile = downloadApk(context, apiBaseUrl, key)
            val actualSha256 = sha256(apkFile)
            if (!actualSha256.equals(manifest.sha256, ignoreCase = true)) {
                apkFile.delete()
                UpdatePrefs.setLastError(context, "Descarga incompleta o corrupta (hash no coincide) - descartada, no se instalo nada")
                return
            }

            installSilently(context, apkFile)
        } catch (e: Exception) {
            UpdatePrefs.setLastError(context, e.message ?: "Error revisando actualizacion")
        }
    }

    // le dice al backend que version tiene instalada esta tableta ahora mismo - alimenta el campo
    // "actualizado/desactualizado" del detalle de vehiculo en el panel de Admin/Supervisor. Nunca
    // debe interrumpir la revision de actualizacion real si falla (sin conexion, servidor caido)
    private fun reportInstalledVersion(context: Context, apiBaseUrl: String, key: String) {
        try {
            val deviceId = TraccarPrefs.getDeviceId(context)
            if (deviceId.isBlank()) return
            val url = URL("$apiBaseUrl/api/app/report-version")
            val conn = url.openConnection() as HttpURLConnection
            conn.connectTimeout = 10000
            conn.readTimeout = 10000
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            val body = JSONObject().apply {
                put("deviceId", deviceId)
                put("versionCode", BuildConfig.VERSION_CODE)
                put("versionName", BuildConfig.VERSION_NAME)
                put("key", key)
            }
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
            conn.responseCode
            conn.disconnect()
        } catch (_: Exception) {
            // reporte informativo unicamente - un fallo aqui no debe tumbar la revision real
        }
    }

    private data class ReleaseManifest(val versionCode: Int, val versionName: String, val sha256: String)

    private fun fetchLatest(apiBaseUrl: String, key: String): ReleaseManifest {
        val url = URL("$apiBaseUrl/api/app/latest?key=${enc(key)}")
        val conn = url.openConnection() as HttpURLConnection
        conn.connectTimeout = 10000
        conn.readTimeout = 10000
        try {
            if (conn.responseCode != 200) throw Exception("HTTP ${conn.responseCode} consultando ultima version")
            val body = conn.inputStream.bufferedReader().readText()
            val json = JSONObject(body)
            return ReleaseManifest(json.getInt("versionCode"), json.getString("versionName"), json.getString("sha256"))
        } finally {
            conn.disconnect()
        }
    }

    // descarga a un archivo .part y solo lo renombra al nombre final (el que installSilently()
    // de verdad instala) si la descarga entera termino sin excepciones - un .part a medias nunca
    // llega a instalarse, y ademas se verifica su hash despues de renombrar
    private fun downloadApk(context: Context, apiBaseUrl: String, key: String): File {
        val dir = File(context.filesDir, "updates").apply { mkdirs() }
        val partFile = File(dir, "update.apk.part")
        val finalFile = File(dir, "update.apk")

        val url = URL("$apiBaseUrl/api/app/download?key=${enc(key)}")
        val conn = url.openConnection() as HttpURLConnection
        conn.connectTimeout = 15000
        conn.readTimeout = 60000
        try {
            if (conn.responseCode != 200) throw Exception("HTTP ${conn.responseCode} descargando APK")
            conn.inputStream.use { input ->
                partFile.outputStream().use { output -> input.copyTo(output) }
            }
        } finally {
            conn.disconnect()
        }

        finalFile.delete()
        if (!partFile.renameTo(finalFile)) throw Exception("No se pudo mover el APK descargado")
        return finalFile
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(8192)
            var read = input.read(buffer)
            while (read != -1) {
                digest.update(buffer, 0, read)
                read = input.read(buffer)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun installSilently(context: Context, apkFile: File) {
        val packageInstaller = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            params.setInstallReason(PackageManager.INSTALL_REASON_POLICY)
        }
        val sessionId = packageInstaller.createSession(params)
        val session = packageInstaller.openSession(sessionId)
        try {
            session.openWrite("update", 0, apkFile.length()).use { out ->
                apkFile.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val intent = Intent(context, UpdateInstallReceiver::class.java)
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            } else {
                PendingIntent.FLAG_UPDATE_CURRENT
            }
            val pendingIntent = PendingIntent.getBroadcast(context, sessionId, intent, flags)
            session.commit(pendingIntent.intentSender)
        } finally {
            session.close()
        }
    }

    private fun enc(v: String) = URLEncoder.encode(v, "UTF-8")
}
