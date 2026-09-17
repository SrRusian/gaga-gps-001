package com.gaga.app.rtk

import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

// Replica "Output to SW Maps" de GNSS Master: un servidor TCP local que retransmite el NMEA crudo
// del receptor (GGA/RMC/etc, tal cual llega) a cualquier app que se conecte como cliente - SW Maps
// y apps similares de GIS aceptan un "GNSS externo por TCP" apuntando a 127.0.0.1:<puerto>.
// Sin uso real confirmado por el equipo (GAGA no usa SW Maps hoy) - se quito el control manual del
// panel de Ajustes (DeviceSettingsPanel.tsx) a proposito, pero la pieza nativa se deja intacta y
// arrancando en el puerto fijo de siempre (11123) via activateGnssService()/applyDefaultProvisioning()
// - listo para usarse de nuevo con solo agregar UI, sin tocar nada de este archivo.
class SwMapsOutputServer {
    private var serverSocket: ServerSocket? = null
    private val clients = mutableListOf<Socket>()

    @Volatile var isRunning: Boolean = false
        private set

    fun start(port: Int) {
        stop()
        // solo localhost - SW Maps corre en el mismo dispositivo, no hace falta (ni conviene)
        // exponer un stream NMEA sin autenticacion al resto de la red local
        val server = ServerSocket(port, 4, InetAddress.getLoopbackAddress())
        serverSocket = server
        isRunning = true
        thread(start = true, isDaemon = true) {
            while (isRunning) {
                try {
                    val client = server.accept()
                    synchronized(clients) { clients.add(client) }
                } catch (_: Exception) {
                    // el socket se cierra al hacer stop() - termina el loop solo
                }
            }
        }
    }

    fun broadcastLine(line: String) {
        if (!isRunning) return
        val data = "$line\r\n".toByteArray()
        synchronized(clients) {
            val iterator = clients.iterator()
            while (iterator.hasNext()) {
                val client = iterator.next()
                try {
                    client.getOutputStream().write(data)
                } catch (_: Exception) {
                    iterator.remove()
                    try {
                        client.close()
                    } catch (_: Exception) {
                    }
                }
            }
        }
    }

    fun stop() {
        isRunning = false
        try {
            serverSocket?.close()
        } catch (_: Exception) {
        }
        serverSocket = null
        synchronized(clients) {
            clients.forEach {
                try {
                    it.close()
                } catch (_: Exception) {
                }
            }
            clients.clear()
        }
    }
}
