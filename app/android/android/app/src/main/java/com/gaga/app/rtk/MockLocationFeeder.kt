package com.gaga.app.rtk

import android.app.AppOpsManager
import android.content.Context
import android.location.Criteria
import android.location.Location
import android.location.LocationManager
import android.location.provider.ProviderProperties
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import com.gaga.app.traccar.TraccarSenderService

// Alimenta el fix RTK corregido al GPS_PROVIDER del sistema via addTestProvider/setTestProviderLocation.
// A partir de ahi, TODO lo que lea LocationManager (navigator.geolocation del WebView incluido,
// TraccarSenderService) recibe automaticamente el fix RTK sin ninguna coordinacion especial - Android
// no distingue "GPS real" de "mock-location del proveedor designado" (mismo comportamiento ya
// documentado para Traccar Client + GNSS Master en este proyecto).
//
// Requiere que el usuario haya elegido esta app como "app de ubicacion simulada" en Opciones de
// desarrollador - Android bloquea deliberadamente setTestProviderLocation si no, sin forma de saltarlo
// por software (proteccion anti-spoofing real, no un permiso que se pueda pedir en runtime).
class MockLocationFeeder(private val context: Context) {
    companion object {
        // Receptor MUDO (ni un byte): se suelta GPS_PROVIDER rapido. Bug real de campo (17 sep):
        // basta UN fix para secuestrar GPS_PROVIDER, y si el receptor deja de entregar despues
        // (crash del USB, cable suelto) el proveedor se quedaba secuestrado y VACIO - el GPS real
        // huerfano y la tableta ciega, sin ningun error visible.
        private const val RECEIVER_SILENT_MS = 6_000L

        // Receptor VIVO pero sin fix (GGA sin coordenadas): margen mucho mas amplio. Con 6s se
        // soltaba y retomaba el proveedor en cada bache corto de fix, haciendo parpadear la
        // notificacion de ubicacion falsa de Android y mezclando posiciones RTK con las del GPS
        // interno en la misma ruta. Ademas, si el receptor (antena en el techo) no ve cielo, el GPS
        // interno de la tableta (dentro de la cabina) tampoco - caer a el ahi no gana nada.
        private const val NO_FIX_GRACE_MS = 30_000L

        private const val WATCHDOG_PERIOD_MS = 2_000L
    }

    private val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private var providerAdded = false
    @Volatile private var lastFedAtMs = 0L
    @Volatile private var lastDataAtMs = 0L
    private val watchdogHandler = Handler(Looper.getMainLooper())

    private val staleWatchdog = object : Runnable {
        override fun run() {
            if (providerAdded) {
                val now = System.currentTimeMillis()
                val silent = now - lastDataAtMs > RECEIVER_SILENT_MS
                val noFix = now - lastFedAtMs > NO_FIX_GRACE_MS
                // requested sigue en true - el proximo fix real vuelve a tomar el proveedor solo
                if (silent || noFix) releaseProvider()
            }
            if (requested) watchdogHandler.postDelayed(this, WATCHDOG_PERIOD_MS)
        }
    }

    // el receptor sigue hablando aunque no tenga fix - lo llama handleReceiverData en cada bloque
    // de bytes, sin importar si se logro parsear algo
    fun noteReceiverAlive() {
        lastDataAtMs = System.currentTimeMillis()
    }

    // true solo mientras el usuario/checklist pidio "ubicacion simulada" (entre start() y stop()) -
    // separado a proposito de providerAdded (que ahora refleja si GPS_PROVIDER de verdad ya fue
    // secuestrado). Bug real reportado en campo: activar "Activar todo" SIN receptor RTK conectado
    // secuestraba GPS_PROVIDER de inmediato en start() - si RTK nunca llegaba a mandar un fix real
    // (sin cable, o desconectado), ese proveedor se quedaba vacio para siempre: el GPS real de la
    // tableta quedaba huerfano, TraccarSenderService (escuchando GPS_PROVIDER) se quedaba mudo. El
    // envio manual seguia "funcionando" solo porque tiene un respaldo a NETWORK_PROVIDER (ver
    // TraccarSenderPlugin.sendNow), enmascarando el problema real. Fix: activacion perezosa -
    // start() ya NO secuestra GPS_PROVIDER, solo lo marca como pedido; el secuestro real ocurre
    // recien en feed(), la primera vez que llega un fix de verdad del receptor. Sin receptor
    // conectado, GPS_PROVIDER nunca se toca y el GPS real de la tableta sigue funcionando normal.
    private var requested = false

    fun start(): Boolean {
        requested = true
        watchdogHandler.removeCallbacks(staleWatchdog)
        watchdogHandler.postDelayed(staleWatchdog, WATCHDOG_PERIOD_MS)
        return isAllowedByOs()
    }

    // suelta GPS_PROVIDER sin cancelar la peticion de ubicacion simulada - se usa cuando el
    // receptor deja de entregar fixes, para que el GPS real de la tableta vuelva a funcionar
    // mientras tanto. A diferencia de stop(), el proximo fix real vuelve a secuestrarlo solo.
    private fun releaseProvider() {
        if (!providerAdded) return
        try {
            locationManager.removeTestProvider(LocationManager.GPS_PROVIDER)
        } catch (_: Exception) {
        }
        providerAdded = false
        TraccarSenderService.reregisterLocationListener()
    }

    private fun addProvider(): Boolean {
        if (providerAdded) return true
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val properties = ProviderProperties.Builder()
                    .setAccuracy(ProviderProperties.ACCURACY_FINE)
                    .setPowerUsage(ProviderProperties.POWER_USAGE_HIGH)
                    .build()
                locationManager.addTestProvider(LocationManager.GPS_PROVIDER, properties)
            } else {
                @Suppress("DEPRECATION")
                locationManager.addTestProvider(
                    LocationManager.GPS_PROVIDER,
                    false, false, false, false, true, true, true,
                    Criteria.POWER_HIGH, Criteria.ACCURACY_FINE,
                )
            }
            locationManager.setTestProviderEnabled(LocationManager.GPS_PROVIDER, true)
            providerAdded = true
            lastFedAtMs = System.currentTimeMillis() // sin esto el watchdog podria soltarlo antes del primer feed
            // addTestProvider() reemplaza el GPS_PROVIDER real - cualquier LocationListener ya
            // registrado contra el proveedor anterior (TraccarSenderService) queda huerfano sin
            // aviso, sin error. Sin esto el envio continuo se quedaba mudo cada vez que RTK
            // activaba ubicacion simulada despues de que el envio ya estuviera corriendo.
            TraccarSenderService.reregisterLocationListener()
            true
        } catch (e: SecurityException) {
            false
        }
    }

    fun feed(fix: NmeaFix) {
        if (!requested) return // nadie pidio ubicacion simulada - no secuestrar GPS_PROVIDER
        val lat = fix.latitude ?: return // sin fix todavia - nada real que alimentar
        val lon = fix.longitude ?: return

        // ESTE metodo corre en el hilo del USB (onDataReceived -> parseGga -> feed). Dar de alta el
        // proveedor toca LocationManager Y re-registra el listener del envio continuo, y eso tiene
        // que pasar en el hilo principal: registrarlo desde aqui lo ataba al Looper de este hilo,
        // que nadie procesa, y el GPS dejaba de entregar en silencio (bug real de campo del 19 sep,
        // ver TraccarSenderService.startLocationUpdates). Se difiere y este fix se salta - el
        // siguiente llega en milisegundos, ya con el proveedor dado de alta.
        if (!providerAdded) {
            watchdogHandler.post { addProvider() }
            return
        }
        lastFedAtMs = System.currentTimeMillis()
        val location = Location(LocationManager.GPS_PROVIDER).apply {
            latitude = lat
            longitude = lon
            if (fix.altitude != null) altitude = fix.altitude
            accuracy = fix.accuracyMeters
            fix.speedMps?.let { speed = it }
            fix.courseDeg?.let { bearing = it }
            time = System.currentTimeMillis()
            elapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
        }
        try {
            locationManager.setTestProviderLocation(LocationManager.GPS_PROVIDER, location)
        } catch (_: SecurityException) {
            // la app dejo de estar seleccionada como app de ubicacion simulada a mitad de sesion
            providerAdded = false
        }
    }

    fun stop() {
        requested = false
        watchdogHandler.removeCallbacks(staleWatchdog)
        // mismo motivo que en addProvider() - volver al GPS real tambien reemplaza el proveedor y
        // deja huerfano al listener del envio continuo, por eso releaseProvider() lo re-registra
        releaseProvider()
    }

    // refleja si GPS_PROVIDER de verdad esta secuestrado ahora mismo (llego al menos un fix real) -
    // ya no "se pidio ubicacion simulada", que es requested. Este es el que ve el checklist de
    // Ajustes ("Ubicacion simulada" checkbox, solo lectura) - mas honesto que antes: si RTK nunca
    // manda un fix real, se queda sin marcar en vez de mostrar "activo" con el GPS real huerfano.
    fun isActive(): Boolean = providerAdded

    // "isActive()" (providerAdded) solo refleja si ESTE proceso ya llamo addTestProvider() con
    // exito - se resetea en cada reinicio de la app aunque la seleccion real de Android
    // ("Seleccionar app de ubicacion falsa" en Opciones de desarrollador) siga siendo esta app,
    // sin haber cambiado. Bug real reportado: el checklist de Ajustes volvia a pedir "verificar"
    // en cada reapertura de la app, aunque el usuario ya lo hubiera configurado bien antes. Esto
    // consulta el permiso real de Android (AppOps), sin efectos secundarios - no requiere haber
    // llamado start() primero, y no cambia con reinicios del proceso.
    fun isAllowedByOs(): Boolean {
        val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_MOCK_LOCATION, Process.myUid(), context.packageName)
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(AppOpsManager.OPSTR_MOCK_LOCATION, Process.myUid(), context.packageName)
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }
}
