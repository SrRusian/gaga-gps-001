package com.gagagps.operator.rtk

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
    private var socket: Socket? = null
    private var outputStream: OutputStream? = null
    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private var readJob: Job? = null
    private var ggaJob: Job? = null

    fun isConnected(): Boolean = socket?.isConnected == true && socket?.isClosed == false

    fun connect(config: NtripConfig) {
        disconnect()
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
                val request = buildString {
                    append("GET /${config.mountpoint} HTTP/1.1\r\n")
                    append("Host: ${config.host}\r\n")
                    append("Ntrip-Version: Ntrip/2.0\r\n")
                    append("User-Agent: NTRIP GagaOperador/1.0\r\n")
                    if (config.username.isNotBlank()) append("Authorization: Basic $auth\r\n")
                    append("Connection: close\r\n")
                    append("\r\n")
                }
                outputStream?.write(request.toByteArray())
                outputStream?.flush()

                val input = s.getInputStream()
                val statusLine = readLine(input)
                if (statusLine == null || (!statusLine.contains("200") && !statusLine.contains("ICY 200"))) {
                    onStatus(false, "Caster rechazo la conexion: ${statusLine ?: "sin respuesta"}")
                    disconnect()
                    return@launch
                }
                // consumir el resto de los headers HTTP hasta la linea en blanco
                while (isActive) {
                    val header = readLine(input) ?: break
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
                disconnect()
            }
        }
    }

    private fun readLine(input: java.io.InputStream): String? {
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

    fun disconnect() {
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
