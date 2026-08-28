package com.gagagps.operator.rtk

// Parser NMEA 0183 minimo - solo GGA (posicion + calidad de fix) y RMC (velocidad/rumbo), que es
// todo lo que un receptor RTK expone por su salida serial ademas del stream RTCM binario.
object NmeaParser {
    private var lastCourse: Float? = null
    private var lastSpeed: Float? = null

    // NMEA manda grados+minutos pegados (ddmm.mmmm / dddmm.mmmm), no grados decimales
    private fun toDecimalDegrees(raw: String, degreesLen: Int): Double? {
        if (raw.isBlank()) return null
        val value = raw.toDoubleOrNull() ?: return null
        val degrees = (value / 100).toInt().toDouble()
        val minutes = value - degrees * 100
        return degrees + minutes / 60.0
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

    // recibe una linea NMEA completa (con $ y checksum), regresa un NmeaFix nuevo solo si era una GGA valida
    fun parseGga(line: String): NmeaFix? {
        val sentence = line.trim()
        if (!sentence.startsWith("$") || !sentence.contains("GGA")) return null
        if (!checksumOk(sentence)) return null

        val body = sentence.substringBefore("*").substring(1)
        val fields = body.split(",")
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
        )
    }

    // RMC solo se usa para complementar velocidad/rumbo del ultimo GGA (GGA no los trae)
    fun parseRmc(line: String) {
        val sentence = line.trim()
        if (!sentence.startsWith("$") || !sentence.contains("RMC")) return
        if (!checksumOk(sentence)) return

        val body = sentence.substringBefore("*").substring(1)
        val fields = body.split(",")
        // $GxRMC,time,status,lat,N/S,lon,E/W,speedKn,course,date,...
        if (fields.size < 9) return

        lastSpeed = fields.getOrNull(7)?.toFloatOrNull()?.let { it * 0.514444f } // nudos a m/s
        lastCourse = fields.getOrNull(8)?.toFloatOrNull()
    }
}
