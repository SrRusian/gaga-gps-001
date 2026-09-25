package com.gaga.app.rtk

import kotlin.math.cos
import kotlin.math.sqrt

// Ancla de posicion con el vehiculo detenido. Bajo techo en DGNSS/RTK FLOAT el receptor entrega
// fixes que "tiemblan" varios metros alrededor del mismo punto sin que nada se haya movido - no son
// fixes malos que haya que descartar, es el error aleatorio normal de esos modos (todos traen el
// mismo error, ninguno es "el bueno"). Por eso el ancla PROMEDIA en vez de congelar el ultimo:
// promediar N mediciones independientes con ruido aleatorio reduce el error por raiz de N, asi que
// el punto anclado es mas preciso que cualquier fix suelto, no menos. Tampoco esconde movimiento:
// un avance real es sostenido en una direccion y el promedio lo sigue.
//
// Que quede detenido lo decide la VELOCIDAD, no la posicion: el Doppler del receptor tiene un ruido
// de decimas de km/h mientras la posicion se va varios metros, asi que comparar fixes crudos entre
// si para ver "si se movio" no funciona - dos lecturas ruidosas se separan tanto como el umbral y
// el ancla nunca llega a engancharse (medido: 0% del tiempo con vaiven de 2m en FLOAT).
//
// Corre en el hilo de lectura del receptor (handleReceiverData), un solo hilo - sin sincronizacion.
class StationaryAnchor {
    // Umbral por VEHICULO, no una constante global. Una excavadora trabaja por debajo de 4 km/h, asi
    // que congelarla a ese umbral esconderia trabajo real; un camion parado si debe congelarse. Lo
    // empuja la capa web desde el tipo de vehiculo asignado (ver setStationaryThreshold). 0 o menos
    // = desactivado, el fix pasa siempre crudo.
    @Volatile var stationarySpeedKmh: Float = DEFAULT_STATIONARY_SPEED_KMH
        set(value) {
            field = value
            reset() // el criterio cambio - lo que estuviera anclado ya no vale
        }

    private var lat: Double? = null
    private var lon: Double? = null
    private var originLat = 0.0
    private var originLon = 0.0
    private var anchored = false
    private var quietStreak = 0
    private var runawayStreak = 0

    fun apply(fix: NmeaFix): NmeaFix {
        val fixLat = fix.latitude ?: return fix
        val fixLon = fix.longitude ?: return fix

        // sin velocidad no hay forma de distinguir detenido de andando (pasa si se apaga RMC desde
        // el panel de configuracion del receptor) - se pasa crudo, nunca se ancla a ciegas
        val speedMps = fix.speedMps ?: run {
            reset()
            return fix
        }
        val speedKmh = speedMps * 3.6f

        val stationaryThreshold = stationarySpeedKmh
        if (stationaryThreshold <= 0f) { // desactivado para este vehiculo (maquinaria lenta)
            reset()
            return fix
        }
        // el hueco entre enganchar y soltar es la histeresis que evita oscilar justo en el limite
        if (speedKmh >= stationaryThreshold * MOVING_SPEED_FACTOR) {
            reset()
            return fix
        }

        val refLat = lat
        val refLon = lon
        if (refLat == null || refLon == null) {
            lat = fixLat
            lon = fixLon
            quietStreak = if (speedKmh < stationaryThreshold) 1 else 0
            return fix
        }

        // red de seguridad por si el receptor reporta 0 con el vehiculo andando. Se mide contra el
        // punto donde se anclo, NO contra el promedio movil: el promedio persigue al fix, asi que
        // la distancia entre los dos nunca crece aunque el vehiculo se vaya (medido). El umbral es
        // enorme comparado con el vaiven de estar quieto para que no dispare por ruido - no es el
        // detector de movimiento, solo evita que el mapa se quede congelado.
        if (anchored) {
            if (distanceMeters(originLat, originLon, fixLat, fixLon) > RUNAWAY_METERS) {
                runawayStreak++
                if (runawayStreak >= RELEASE_SAMPLES) {
                    reset()
                    return fix
                }
            } else {
                runawayStreak = 0
            }
        }

        // asimetrico a proposito: lento para enganchar (hay que ver quietud sostenida), rapido
        // para soltar (arriba). Una velocidad entre los dos umbrales corta la racha pero no rompe
        // un ancla ya puesta - esa es la histeresis que evita que oscile justo en el limite.
        if (speedKmh < stationaryThreshold) quietStreak++ else quietStreak = 0

        val alpha = if (anchored) ANCHOR_ALPHA else SETTLE_ALPHA
        val nextLat = refLat + (fixLat - refLat) * alpha
        val nextLon = refLon + (fixLon - refLon) * alpha
        lat = nextLat
        lon = nextLon

        if (!anchored) {
            if (quietStreak < SETTLE_SAMPLES) return fix
            anchored = true
            originLat = nextLat
            originLon = nextLon
        }
        return fix.copy(latitude = nextLat, longitude = nextLon, speedMps = 0f)
    }

    fun reset() {
        lat = null
        lon = null
        anchored = false
        quietStreak = 0
        runawayStreak = 0
    }

    // equirectangular local, no haversine - a escala de metros es igual de exacta y numericamente
    // mas estable (haversine eleva al cuadrado senos del orden de 1e-8 y pierde digitos justo en
    // este rango). Mismo criterio que toLocalMeters() en backend/src/utils/vehicleFootprint.ts
    private fun distanceMeters(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val midLatRad = Math.toRadians((lat1 + lat2) / 2)
        val dy = Math.toRadians(lat2 - lat1) * EARTH_RADIUS_M
        val dx = Math.toRadians(lon2 - lon1) * EARTH_RADIUS_M * cos(midLatRad)
        return sqrt(dx * dx + dy * dy)
    }

    companion object {
        // default cuando el dispositivo no tiene tipo de vehiculo asignado - mismo valor de siempre
        const val DEFAULT_STATIONARY_SPEED_KMH = 4f

        // multiplicador del umbral para soltar (4 km/h para enganchar -> 6 km/h para soltar)
        private const val MOVING_SPEED_FACTOR = 1.5f

        // a 10Hz: 1s de quietud para enganchar, 0.3s para la red de seguridad
        private const val SETTLE_SAMPLES = 10
        private const val RELEASE_SAMPLES = 3

        // ventana efectiva ~20 muestras (2s a 10Hz): divide el ruido entre ~4.5 y aun asi sigue un
        // avance real muy lento sin perderlo
        private const val ANCHOR_ALPHA = 0.05
        private const val SETTLE_ALPHA = 0.3

        private const val RUNAWAY_METERS = 30.0
        private const val EARTH_RADIUS_M = 6371000.0
    }
}
