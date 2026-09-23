package com.gaga.app.rtk

import kotlin.math.sqrt

// un satelite a la vista, tal como lo reporta GSV. signalId distingue la banda (1 = L1C/A,
// 6 = GPS L2 CL, 3 = GLONASS L2 OF...), asi que un mismo satelite puede aparecer dos veces.
data class SatelliteInfo(
    val constellation: String,
    val id: Int,
    val elevation: Int?,
    val azimuth: Int?,
    val snr: Int?, // null = rastreado pero sin medida de señal
    val signalId: Int,
    val used: Boolean, // entra al calculo de posicion (viene de GSA)
)

data class GnssDiagnostics(
    val satellites: List<SatelliteInfo>,
    val pdop: Double?,
    val hdop: Double?,
    val vdop: Double?,
    val dimension: Int?, // 2 o 3, de GSA - null si nunca llego un GSA valido
)

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
    // hora UTC real del GPS (RMC time+date combinados) - null hasta el primer RMC con fecha
    // valida. Distinto de timestamp (reloj de Android al momento de parsear la linea)
    val gpsTimeMs: Long? = null,
    // desviacion estandar real del receptor (GST) - null si GST no esta habilitado
    val stdLatMeters: Double? = null,
    val stdLonMeters: Double? = null,
    val stdAltMeters: Double? = null,
    // separacion entre el geoide (nivel del mar) y el elipsoide WGS84 en este punto (campo 11 de
    // la GGA) - altitud MSL + esto = altitud elipsoidal, la que u-center muestra como "Altitude"
    val geoidSepMeters: Double? = null,
    // ultimos 2 campos de la GGA: segundos desde la ultima correccion y estacion base que corrige
    val correctionAgeSeconds: Double? = null,
    val stationId: String? = null,
) {
    val fixLabel: String
        get() = when (fixQuality) {
            4 -> "RTK_FIX"
            5 -> "RTK_FLOAT"
            2 -> "DGPS"
            1 -> "GPS"
            else -> "SIN_FIX"
        }

    // error horizontal real medido por el receptor, solo si GST viene habilitado
    val horizontalStdMeters: Float?
        get() {
            val la = stdLatMeters ?: return null
            val lo = stdLonMeters ?: return null
            return sqrt(la * la + lo * lo).toFloat()
        }

    // error 3D (horizontal + vertical combinados) - solo si GST viene habilitado
    val fullStdMeters: Float?
        get() {
            val h = horizontalStdMeters ?: return null
            val v = stdAltMeters ?: return null
            return sqrt(h * h + v.toFloat() * v.toFloat())
        }

    // altitud sobre el elipsoide WGS84 (lo que u-center llama "Altitude" a secas, distinto de
    // "Altitude (msl)") - GGA solo trae la altitud MSL directo, esto reconstruye la otra
    val ellipsoidalAltitudeMeters: Double?
        get() {
            val alt = altitude ?: return null
            val sep = geoidSepMeters ?: return null
            return alt + sep
        }

    // precision para el circulo del mapa. Prefiere la medicion real de GST; sin ella cae a una
    // estimacion conservadora por tipo de fix (mismo criterio de "sin piso artificial" que
    // packages/map-core/vehicleMarker.ts)
    val accuracyMeters: Float
        get() = horizontalStdMeters ?: when (fixQuality) {
            4 -> 0.03f
            5 -> 0.5f
            2 -> 2.5f
            1 -> 5f
            else -> 15f
        }
}
