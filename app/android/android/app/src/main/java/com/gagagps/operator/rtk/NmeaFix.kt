package com.gagagps.operator.rtk

// snapshot de la ultima posicion reportada por el receptor RTK via NMEA GGA/RMC. lat/lon nulos
// = el receptor todavia no tiene ningun tipo de fix (manda esos campos vacios) - sigue siendo un
// GGA valido que hay que mostrar como "buscando satelites", no descartarlo como linea invalida
data class NmeaFix(
    val latitude: Double?,
    val longitude: Double?,
    val altitude: Double?,
    val fixQuality: Int, // 0 invalido, 1 GPS, 2 DGPS, 4 RTK FIX, 5 RTK FLOAT
    val satellites: Int,
    val hdop: Double?,
    val speedMps: Float?,
    val courseDeg: Float?,
    val timestamp: Long,
) {
    val fixLabel: String
        get() = when (fixQuality) {
            4 -> "RTK_FIX"
            5 -> "RTK_FLOAT"
            2 -> "DGPS"
            1 -> "GPS"
            else -> "SIN_FIX"
        }

    // estimacion conservadora de precision real por tipo de fix, para el circulo de precision
    // del propio mapa (mismo criterio de "sin piso artificial" que packages/map-core/vehicleMarker.ts)
    val accuracyMeters: Float
        get() = when (fixQuality) {
            4 -> 0.03f
            5 -> 0.5f
            2 -> 2.5f
            1 -> 5f
            else -> 15f
        }
}
