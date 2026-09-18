package com.gaga.app.rtk

// Ultimo rumbo de brujula ya corregido por la auto-calibracion de montaje de la tableta
// (headingCalibration.ts del lado web). Vive aparte de RtkNtripPlugin para que TraccarUplink pueda
// leerlo sin depender del mundo de plugins de Capacitor, igual que el resto de puentes del proyecto.
object CompassHeadingHolder {
    // mas viejo que esto se considera inservible: la brujula solo vale si esta viva ahora mismo
    private const val MAX_AGE_MS = 3_000L

    @Volatile private var headingDeg: Float? = null
    @Volatile private var updatedAtMs: Long = 0L

    fun set(heading: Float) {
        headingDeg = heading
        updatedAtMs = System.currentTimeMillis()
    }

    fun recent(): Float? {
        val heading = headingDeg ?: return null
        if (System.currentTimeMillis() - updatedAtMs > MAX_AGE_MS) return null
        return heading
    }
}
