package com.gagagps.operator.rtk

// Data rate (bytes/segundo) + total acumulado de un flujo de bytes en vivo - usado tanto para el
// receptor USB como para el stream RTCM del caster NTRIP. El rate recalcula cuando pasa >=1s desde
// la ultima ventana (no necesita su propio hilo/timer, se apoya en la llegada de datos real) y
// decae a 0 si el flujo se detiene por completo (evita mostrar un numero "congelado"). El total
// se reinicia solo al reconectar (mismo criterio que GNSS Master - total de ESTA conexion).
class RateTracker {
    private var windowStartMs = System.currentTimeMillis()
    private var windowBytes = 0L
    private var lastComputed = 0.0
    private var lastDataAtMs = 0L

    @Volatile var totalBytes: Long = 0L
        private set

    @Synchronized
    fun addBytes(n: Int) {
        totalBytes += n
        val now = System.currentTimeMillis()
        lastDataAtMs = now
        windowBytes += n
        val elapsed = now - windowStartMs
        if (elapsed >= 1000) {
            lastComputed = windowBytes * 1000.0 / elapsed
            windowBytes = 0
            windowStartMs = now
        }
    }

    @Synchronized
    fun currentBytesPerSecond(): Double {
        if (System.currentTimeMillis() - lastDataAtMs > 3000) return 0.0
        return lastComputed
    }

    @Synchronized
    fun reset() {
        totalBytes = 0L
        windowBytes = 0L
        lastComputed = 0.0
        lastDataAtMs = 0L
        windowStartMs = System.currentTimeMillis()
    }
}
