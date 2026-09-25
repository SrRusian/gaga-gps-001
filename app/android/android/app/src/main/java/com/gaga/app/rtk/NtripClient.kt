package com.gaga.app.rtk

import android.os.Handler
import android.os.Looper
import android.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.OutputStream
import java.net.Socket
import java.net.SocketTimeoutException

data class NtripConfig(
    val host: String,
    val port: Int,
    val mountpoint: String,
    val username: String,
    val password: String,
    val version: NtripVersion = NtripVersion.V2,
)

// Cliente NTRIP v1/v2 minimo: pide el mountpoint por HTTP crudo sobre un socket TCP (la respuesta
// es un stream binario RTCM3 continuo, no encaja en HttpURLConnection) y reenvia cada correccion
// recibida al receptor por USB. Manda GGA periodico - varios casters (VRS en particular) necesitan
// saber donde esta el rover para mandar la correccion correcta de esa zona.
class NtripClient(
    private val onRtcmData: (ByteArray) -> Unit,
    private val onStatus: (connected: Boolean, error: String?) -> Unit,
    private val currentGga: () -> String?,
) {
    companion object {
        // mismo criterio que BluetoothSerialManager: reintento fijo, sin backoff exponencial - el
        // proyecto prefiere "cero toques" (se reconecta solo) sobre optimizar el ritmo del reintento
        private const val RETRY_DELAY_MS = 5000L
    }

    private var socket: Socket? = null
    private var outputStream: OutputStream? = null
    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private var readJob: Job? = null
    private var ggaJob: Job? = null
    private val retryHandler = Handler(Looper.getMainLooper())

    // bug real reportado en campo: el caster cerraba la conexion ("Software caused connection
    // abort" - tipico de que Android mate el socket al pasar a segundo plano/Doze, o un reset del
    // lado del caster) y NTRIP se quedaba muerto para siempre - RtkNtripPlugin.onReceiverConnected()
    // solo reintenta si `ntrip == null`, y esta MISMA instancia seguia viva referenciando un socket
    // ya cerrado. La unica forma de recuperarlo era matar el proceso completo (onCreate vuelve a
    // arrancar todo desde cero). Mismo patron ya probado en BluetoothSerialManager: `connect()`
    // marca la intencion de seguir conectado, cualquier caida NO intencional (cualquier camino que
    // no sea `disconnect()`) programa un reintento solo
    @Volatile private var shouldStayConnected = false
    private var lastConfig: NtripConfig? = null

    fun isConnected(): Boolean = socket?.isConnected == true && socket?.isClosed == false

    fun connect(config: NtripConfig) {
        shouldStayConnected = true
        lastConfig = config
        retryHandler.removeCallbacksAndMessages(null)
        teardown()
        attemptConnect(config)
    }

    private fun attemptConnect(config: NtripConfig) {
        readJob = scope.launch {
            try {
                val s = Socket(config.host, config.port)
                s.soTimeout = 15000
                socket = s
                outputStream = s.getOutputStream()

                val auth = Base64.encodeToString(
                    "${config.username}:${config.password}".toByteArray(),
                    Base64.NO_WRAP,
                )
                // v1 es el formato original (minimo, sin Host/Ntrip-Version/Connection) - v2 agrega
                // esos headers y usa HTTP/1.1 de verdad. La linea de estado se acepta igual en
                // ambos casos ("HTTP/1.1 200" o el "ICY 200 OK" clasico de v1 estilo Icecast)
                val isV1 = config.version == NtripVersion.V1
                val request = buildString {
                    append("GET /${config.mountpoint} ${if (isV1) "HTTP/1.0" else "HTTP/1.1"}\r\n")
                    if (!isV1) {
                        append("Host: ${config.host}\r\n")
                        append("Ntrip-Version: Ntrip/2.0\r\n")
                    }
                    append("User-Agent: NTRIP GagaOperador/1.0\r\n")
                    if (config.username.isNotBlank()) append("Authorization: Basic $auth\r\n")
                    if (!isV1) append("Connection: close\r\n")
                    append("\r\n")
                }
                outputStream?.write(request.toByteArray())
                outputStream?.flush()

                val input = s.getInputStream()
                val statusLine = readNtripLine(input)
                if (statusLine == null || (!statusLine.contains("200") && !statusLine.contains("ICY 200"))) {
                    onStatus(false, "Caster rechazo la conexion: ${statusLine ?: "sin respuesta"}")
                    return@launch
                }
                // consumir el resto de los headers HTTP hasta la linea en blanco
                while (isActive) {
                    val header = readNtripLine(input) ?: break
                    if (header.isEmpty()) break
                }

                onStatus(true, null)
                startGgaHeartbeat()

                val buffer = ByteArray(2048)
                while (isActive) {
                    val read = input.read(buffer)
                    if (read <= 0) break
                    onRtcmData(buffer.copyOf(read))
                }
                onStatus(false, "Conexion con el caster cerrada")
            } catch (e: SocketTimeoutException) {
                onStatus(false, "Tiempo de espera agotado conectando al caster")
            } catch (e: Exception) {
                onStatus(false, "Error NTRIP: ${e.message}")
            } finally {
                teardown()
                scheduleRetry()
            }
        }
    }

    private fun scheduleRetry() {
        if (!shouldStayConnected) return
        val config = lastConfig ?: return
        retryHandler.removeCallbacksAndMessages(null)
        retryHandler.postDelayed({
            if (shouldStayConnected) attemptConnect(config)
        }, RETRY_DELAY_MS)
    }

    private fun startGgaHeartbeat() {
        ggaJob?.cancel()
        ggaJob = scope.launch {
            while (isActive) {
                delay(10_000)
                val gga = currentGga() ?: continue
                try {
                    outputStream?.write("$gga\r\n".toByteArray())
                    outputStream?.flush()
                } catch (_: Exception) {
                }
            }
        }
    }

    // parada INTENCIONAL (stopNtrip()/onReceiverDisconnected() sin ningun transporte vivo) - a
    // diferencia de teardown(), esta corta el reintento automatico. Sin este flag, un `disconnect()`
    // intencional se hubiera reconectado solo 5s despues, deshaciendo la intencion de apagarlo
    fun disconnect() {
        shouldStayConnected = false
        retryHandler.removeCallbacksAndMessages(null)
        teardown()
    }

    // limpieza de socket/jobs sin tocar shouldStayConnected - la usan tanto connect() (antes de
    // abrir una conexion nueva) como el finally de attemptConnect() (conexion caida, no intencional)
    private fun teardown() {
        ggaJob?.cancel()
        readJob?.cancel()
        try {
            socket?.close()
        } catch (_: Exception) {
        }
        socket = null
        outputStream = null
    }
}

// compartido con NtripSourceTable.kt - lee una linea de texto terminada en CRLF de un socket
// crudo (no hay BufferedReader porque despues del handshake el mismo stream cambia a binario RTCM)
internal fun readNtripLine(input: java.io.InputStream): String? {
    val sb = StringBuilder()
    var prev = -1
    while (true) {
        val c = input.read()
        if (c == -1) return if (sb.isEmpty()) null else sb.toString()
        if (prev == '\r'.code && c == '\n'.code) {
            sb.setLength(sb.length - 1)
            return sb.toString()
        }
        sb.append(c.toChar())
        prev = c
    }
}
