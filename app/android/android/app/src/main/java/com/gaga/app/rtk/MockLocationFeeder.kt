package com.gaga.app.rtk

import android.app.AppOpsManager
import android.content.Context
import android.location.Criteria
import android.location.Location
import android.location.LocationManager
import android.location.provider.ProviderProperties
import android.os.Build
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
    private val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private var providerAdded = false

    fun start(): Boolean {
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
        if (!providerAdded) return
        val lat = fix.latitude ?: return // sin fix todavia - nada real que alimentar
        val lon = fix.longitude ?: return
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
        if (!providerAdded) return
        try {
            locationManager.removeTestProvider(LocationManager.GPS_PROVIDER)
        } catch (_: Exception) {
        }
        providerAdded = false
        // mismo motivo que en start() - volver al GPS real tambien reemplaza el proveedor y deja
        // huerfano al listener del envio continuo
        TraccarSenderService.reregisterLocationListener()
    }

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
