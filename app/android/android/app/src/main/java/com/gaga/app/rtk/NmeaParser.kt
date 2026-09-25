package com.gaga.app.rtk

import java.util.Calendar
import java.util.TimeZone
import java.util.concurrent.ConcurrentHashMap

// Parser NMEA 0183 - GGA (posicion + calidad), RMC (velocidad/rumbo), GSV (satelites a la vista),
// GSA (satelites en uso + DOP) y GST (error real de posicion). GSV/GSA/GST alimentan el panel de
// diagnostico de Ajustes, que replica las vistas de u-center sin necesitar una laptop.
object NmeaParser {
    private const val SATELLITE_TTL_MS = 4_000L

    @Volatile private var lastCourse: Float? = null
    @Volatile private var lastSpeed: Float? = null
    @Volatile private var lastGpsTimeMs: Long? = null
    @Volatile private var lastStdLat: Double? = null
    @Volatile private var lastStdLon: Double? = null
    @Volatile private var lastStdAlt: Double? = null
    @Volatile private var lastDimension: Int? = null
    @Volatile private var lastPdop: Double? = null
    @Volatile private var lastHdop: Double? = null
    @Volatile private var lastVdop: Double? = null

    // llega desde el hilo del transporte (USB/Bluetooth) y se lee desde el hilo principal
    private val satellites = ConcurrentHashMap<String, TrackedSatellite>()
    private val usedIds = ConcurrentHashMap.newKeySet<String>()

    private data class TrackedSatellite(val info: SatelliteInfo, val seenAtMs: Long)

    // NMEA manda grados+minutos pegados (ddmm.mmmmm / dddmm.mmmmm), no grados decimales
    private fun toDecimalDegrees(raw: String, degreesLen: Int): Double? {
        if (raw.isBlank()) return null
        val value = raw.toDoubleOrNull() ?: return null
        val degrees = (value / 100).toInt().toDouble()
        val minutes = value - degrees * 100
        return degrees + minutes / 60.0
    }

    // combina time (HHMMSS.ss) y date (DDMMYY) de RMC en un epoch UTC - unico mensaje NMEA que
    // trae fecha completa, GGA solo trae la hora. Sirve para el panel "Watch" del diagnostico:
    // comparar esto contra el reloj de la tableta confirma que el receptor tiene hora GPS real,
    // en vez de mostrar el reloj de Android (que siempre "coincidiria" y no diria nada util)
    private fun combineGpsDateTime(timeRaw: String?, dateRaw: String?): Long? {
        if (timeRaw == null || timeRaw.length < 6 || dateRaw == null || dateRaw.length != 6) return null
        val hour = timeRaw.substring(0, 2).toIntOrNull() ?: return null
        val minute = timeRaw.substring(2, 4).toIntOrNull() ?: return null
        val second = timeRaw.substring(4, 6).toIntOrNull() ?: return null
        val day = dateRaw.substring(0, 2).toIntOrNull() ?: return null
        val month = dateRaw.substring(2, 4).toIntOrNull() ?: return null
        val year = dateRaw.substring(4, 6).toIntOrNull() ?: return null
        return try {
            val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
            cal.clear()
            cal.set(2000 + year, month - 1, day, hour, minute, second)
            cal.timeInMillis
        } catch (_: Exception) {
            null
        }
    }

    private fun checksumOk(sentence: String): Boolean {
        val starIdx = sentence.lastIndexOf('*')
        if (starIdx == -1 || starIdx + 3 > sentence.length) return false
        val body = sentence.substring(1, starIdx)
        val expected = sentence.substring(starIdx + 1, starIdx + 3).toIntOrNull(16) ?: return false
        var actual = 0
        for (c in body) actual = actual xor c.code
        return actual == expected
    }

    // el prefijo de 2 letras del talker identifica la constelacion
    private fun constellationOf(talker: String): String = when {
        talker.startsWith("GP") -> "GPS"
        talker.startsWith("GL") -> "GLONASS"
        talker.startsWith("GA") -> "Galileo"
        talker.startsWith("GB") || talker.startsWith("BD") -> "BeiDou"
        talker.startsWith("GQ") -> "QZSS"
        talker.startsWith("GI") -> "NavIC"
        else -> "GNSS"
    }

    // systemId del ultimo campo de GSA (NMEA 4.11)
    private fun constellationOfSystemId(id: Int?): String = when (id) {
        1 -> "GPS"
        2 -> "GLONASS"
        3 -> "Galileo"
        4 -> "BeiDou"
        5 -> "QZSS"
        6 -> "NavIC"
        else -> "GNSS"
    }

    private fun fieldsOf(line: String, marker: String): List<String>? {
        val sentence = line.trim()
        if (!sentence.startsWith("$") || !sentence.contains(marker)) return null
        if (!checksumOk(sentence)) return null
        return sentence.substringBefore("*").substring(1).split(",")
    }

    // recibe una linea NMEA completa (con $ y checksum), regresa un NmeaFix nuevo solo si era una GGA valida
    fun parseGga(line: String): NmeaFix? {
        val fields = fieldsOf(line, "GGA") ?: return null
        // $GxGGA,time,lat,N/S,lon,E/W,quality,sats,hdop,alt,M,geoidSep,M,age,stationId
        if (fields.size < 10) return null

        val latRaw = fields.getOrNull(2) ?: ""
        val latHemi = fields.getOrNull(3) ?: "N"
        val lonRaw = fields.getOrNull(4) ?: ""
        val lonHemi = fields.getOrNull(5) ?: "E"
        val quality = fields.getOrNull(6)?.toIntOrNull() ?: 0
        val sats = fields.getOrNull(7)?.toIntOrNull() ?: 0
        val hdop = fields.getOrNull(8)?.toDoubleOrNull()
        val altitude = fields.getOrNull(9)?.toDoubleOrNull()

        // lat/lon vienen vacios cuando el receptor todavia no tiene ningun tipo de fix - eso NO
        // invalida la linea, sigue siendo un GGA real que hay que mostrar como "buscando satelites"
        var lat = toDecimalDegrees(latRaw, 2)
        var lon = toDecimalDegrees(lonRaw, 3)
        if (latHemi == "S") lat = lat?.let { -it }
        if (lonHemi == "W") lon = lon?.let { -it }

        return NmeaFix(
            latitude = lat,
            longitude = lon,
            altitude = altitude,
            fixQuality = quality,
            satellites = sats,
            hdop = hdop,
            speedMps = lastSpeed,
            courseDeg = lastCourse,
            timestamp = System.currentTimeMillis(),
            gpsTimeMs = lastGpsTimeMs,
            stdLatMeters = lastStdLat,
            stdLonMeters = lastStdLon,
            stdAltMeters = lastStdAlt,
            geoidSepMeters = fields.getOrNull(11)?.toDoubleOrNull(),
            correctionAgeSeconds = fields.getOrNull(13)?.toDoubleOrNull(),
            stationId = fields.getOrNull(14)?.takeIf { it.isNotBlank() },
        )
    }

    // RMC solo se usa para complementar velocidad/rumbo del ultimo GGA (GGA no los trae)
    fun parseRmc(line: String) {
        val fields = fieldsOf(line, "RMC") ?: return
        // $GxRMC,time,status,lat,N/S,lon,E/W,speedKn,course,date,...
        if (fields.size < 9) return

        lastSpeed = fields.getOrNull(7)?.toFloatOrNull()?.let { it * 0.514444f } // nudos a m/s
        lastCourse = fields.getOrNull(8)?.toFloatOrNull()
        lastGpsTimeMs = combineGpsDateTime(fields.getOrNull(1), fields.getOrNull(9))
    }

    // GST trae el error REAL estimado por el receptor, no una categoria por tipo de fix.
    // No viene activo de fabrica - hay que habilitarlo en u-center (ver README).
    fun parseGst(line: String) {
        val fields = fieldsOf(line, "GST") ?: return
        // $GxGST,time,rangeRms,stdMajor,stdMinor,orient,stdLat,stdLon,stdAlt
        if (fields.size < 9) return

        lastStdLat = fields.getOrNull(6)?.toDoubleOrNull()
        lastStdLon = fields.getOrNull(7)?.toDoubleOrNull()
        lastStdAlt = fields.getOrNull(8)?.toDoubleOrNull()
    }

    // GSA: que satelites entran de verdad al calculo, mas los DOP
    fun parseGsa(line: String) {
        val fields = fieldsOf(line, "GSA") ?: return
        // $GxGSA,mode,fixType,sv1..sv12,pdop,hdop,vdop,systemId - fixType: 1 sin fix, 2 2D, 3 3D
        if (fields.size < 18) return
        lastDimension = fields.getOrNull(2)?.toIntOrNull()

        val constellation = constellationOfSystemId(fields.getOrNull(18)?.toIntOrNull())
        // se limpian solo los de ESTA constelacion - cada GSA habla de una sola
        usedIds.removeIf { it.startsWith("$constellation-") }
        for (i in 3..14) {
            val prn = fields.getOrNull(i)?.toIntOrNull() ?: continue
            usedIds.add("$constellation-$prn")
        }

        lastPdop = fields.getOrNull(15)?.toDoubleOrNull()
        lastHdop = fields.getOrNull(16)?.toDoubleOrNull()
        lastVdop = fields.getOrNull(17)?.toDoubleOrNull()
    }

    // GSV: satelites a la vista con elevacion, azimut y SNR. Llega repartida en varias sentencias
    // por constelacion Y por señal (signalId distingue L1 de L2), asi que en vez de reconstruir la
    // secuencia se guarda cada satelite con su hora y se descarta lo que deja de reportarse.
    fun parseGsv(line: String) {
        val fields = fieldsOf(line, "GSV") ?: return
        if (fields.size < 4) return

        val msgNum = fields.getOrNull(2)?.toIntOrNull() ?: return
        val totalSats = fields.getOrNull(3)?.toIntOrNull() ?: return
        val count = minOf(4, totalSats - (msgNum - 1) * 4)
        if (count <= 0) return

        val constellation = constellationOf(fields[0])
        val signalId = fields.getOrNull(4 + count * 4)?.toIntOrNull() ?: 1
        val now = System.currentTimeMillis()

        for (n in 0 until count) {
            val base = 4 + n * 4
            if (base + 3 >= fields.size) break
            val prn = fields[base].toIntOrNull() ?: continue
            satellites["$constellation-$signalId-$prn"] = TrackedSatellite(
                info = SatelliteInfo(
                    constellation = constellation,
                    id = prn,
                    elevation = fields[base + 1].toIntOrNull(),
                    azimuth = fields[base + 2].toIntOrNull(),
                    snr = fields[base + 3].toIntOrNull(),
                    signalId = signalId,
                    used = usedIds.contains("$constellation-$prn"),
                ),
                seenAtMs = now,
            )
        }
    }

    // snapshot para el panel de diagnostico - descarta lo que dejo de reportarse
    fun diagnostics(): GnssDiagnostics {
        val cutoff = System.currentTimeMillis() - SATELLITE_TTL_MS
        satellites.entries.removeIf { it.value.seenAtMs < cutoff }
        val list = satellites.values
            .map { it.info.copy(used = usedIds.contains("${it.info.constellation}-${it.info.id}")) }
            .sortedWith(compareBy({ it.constellation }, { it.id }, { it.signalId }))
        return GnssDiagnostics(list, lastPdop, lastHdop, lastVdop, lastDimension)
    }

    // el receptor se desconecto - lo que quede en memoria ya no representa nada real
    fun resetDiagnostics() {
        satellites.clear()
        usedIds.clear()
        lastPdop = null
        lastHdop = null
        lastVdop = null
        lastStdLat = null
        lastStdLon = null
        lastStdAlt = null
        lastDimension = null
    }
}
