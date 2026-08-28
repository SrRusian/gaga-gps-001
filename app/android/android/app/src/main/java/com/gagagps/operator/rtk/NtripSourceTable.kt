package com.gagagps.operator.rtk

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.Socket
import java.net.SocketTimeoutException

// una entrada "STR;..." de la sourcetable NTRIP - formato estandar (RTCM Ntrip 1/2), el mismo
// que cualquier caster real expone al pedir la raiz ("/") en vez de un mountpoint especifico
data class NtripMountpoint(
    val mountpoint: String,
    val identifier: String,
    val format: String,
    val navSystem: String,
    val country: String,
    val latitude: Double?,
    val longitude: Double?,
    val nmeaRequired: Boolean,
)

// GET / (sin mountpoint) contra cualquier caster NTRIP real regresa la lista completa de puntos
// de montura disponibles - estandar del protocolo, no algo especifico de un proveedor. Formato:
// lineas "STR;mountpoint;identifier;format;format-details;carrier;nav-system;network;country;
// lat;lon;nmea;solution;generator;compr-encr;auth;fee;bitrate;..." hasta "ENDSOURCETABLE".
object NtripSourceTable {
    suspend fun fetch(host: String, port: Int): List<NtripMountpoint> = withContext(Dispatchers.IO) {
        val socket = Socket(host, port)
        socket.soTimeout = 10000
        try {
            val request = "GET / HTTP/1.1\r\n" +
                "Host: $host\r\n" +
                "User-Agent: NTRIP GagaOperador/1.0\r\n" +
                "Connection: close\r\n\r\n"
            socket.getOutputStream().write(request.toByteArray())
            socket.getOutputStream().flush()

            val input = socket.getInputStream()
            val statusLine = readNtripLine(input)
            if (statusLine == null || (!statusLine.contains("200") && !statusLine.contains("SOURCETABLE"))) {
                throw Exception("El caster no respondio con la tabla de fuentes: ${statusLine ?: "sin respuesta"}")
            }
            while (true) {
                val header = readNtripLine(input) ?: break
                if (header.isEmpty()) break
            }

            val mountpoints = mutableListOf<NtripMountpoint>()
            while (true) {
                val row = readNtripLine(input) ?: break
                if (row.startsWith("ENDSOURCETABLE")) break
                if (!row.startsWith("STR;")) continue
                val f = row.split(";")
                if (f.size < 9) continue
                mountpoints.add(
                    NtripMountpoint(
                        mountpoint = f.getOrElse(1) { "" },
                        identifier = f.getOrElse(2) { "" },
                        format = f.getOrElse(3) { "" },
                        navSystem = f.getOrElse(6) { "" },
                        country = f.getOrElse(8) { "" },
                        latitude = f.getOrNull(9)?.toDoubleOrNull(),
                        longitude = f.getOrNull(10)?.toDoubleOrNull(),
                        nmeaRequired = f.getOrNull(11) == "1",
                    ),
                )
            }
            mountpoints
        } catch (e: SocketTimeoutException) {
            throw Exception("Tiempo de espera agotado consultando el caster")
        } finally {
            try {
                socket.close()
            } catch (_: Exception) {
            }
        }
    }
}
