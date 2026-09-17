package com.gaga.app.update

import android.content.Context
import com.gaga.app.traccar.TraccarPrefs
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

// puente con Firebase Cloud Messaging - unico canal que llega a la tableta sin importar que
// pantalla este mostrando la app (Login, Ajustes, Operador), sin sesion de operador iniciada, e
// incluso con la app cerrada (dentro de los limites normales de Android) - a diferencia de la
// senal por socket de "Actualizar ahora" (useOperatorSocket.ts), que solo llega si el operador
// tiene la app abierta en el mapa con sesion iniciada (esa se queda como respaldo instantaneo
// para ese caso, este es el canal que cubre todo lo demas).
class FCMService : FirebaseMessagingService() {
    companion object {
        private val executor = Executors.newSingleThreadExecutor()

        // llamado desde TraccarSenderService.onCreate() ademas de onNewToken() (que solo dispara
        // en la primera instalacion o cuando Firebase rota el token de verdad) - practica
        // recomendada por la propia documentacion de Firebase, para no depender solo de ese
        // callback si por algun motivo no alcanzo a dispararse a tiempo
        fun requestAndReportCurrentToken(context: Context) {
            try {
                FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                    if (task.isSuccessful) {
                        task.result?.let { reportToken(context.applicationContext, it) }
                    }
                }
            } catch (_: Exception) {
            }
        }

        private fun reportToken(context: Context, token: String) {
            executor.execute {
                try {
                    val apiBaseUrl = UpdatePrefs.getApiBaseUrl(context).trim().trimEnd('/')
                    val key = UpdatePrefs.getKey(context).trim()
                    val deviceId = TraccarPrefs.getDeviceId(context)
                    if (apiBaseUrl.isEmpty() || key.isEmpty() || deviceId.isBlank()) return@execute
                    val url = URL("$apiBaseUrl/api/app/fcm-token")
                    val conn = url.openConnection() as HttpURLConnection
                    conn.connectTimeout = 10000
                    conn.readTimeout = 10000
                    conn.requestMethod = "POST"
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", "application/json")
                    val body = JSONObject().apply {
                        put("deviceId", deviceId)
                        put("token", token)
                        put("key", key)
                    }
                    conn.outputStream.use { it.write(body.toString().toByteArray()) }
                    conn.responseCode
                    conn.disconnect()
                } catch (_: Exception) {
                    // informativo unicamente - un fallo aqui no debe tumbar nada mas, el proximo
                    // arranque (o el siguiente onNewToken/requestAndReportCurrentToken) reintenta
                }
            }
        }
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        reportToken(applicationContext, token)
    }

    // payload esperado del backend: {"type": "force_update"} en el data del mensaje (ver
    // backend/src/services/push/ - se implementa cuando se tengan las credenciales de Firebase
    // Admin del lado del servidor). Cualquier otro tipo se ignora a proposito, para poder agregar
    // mas usos de FCM despues (ej. alertas criticas) sin romper este manejador.
    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        if (message.data["type"] == "force_update") {
            executor.execute { AppUpdateManager.checkAndInstall(applicationContext) }
        }
    }
}
