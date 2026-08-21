package com.gagagps.operator.rtk

import android.content.Context
import android.location.Criteria
import android.location.Location
import android.location.LocationManager
import android.location.provider.ProviderProperties
import android.os.Build
import android.os.SystemClock

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
            true
        } catch (e: SecurityException) {
            false
        }
    }

    fun feed(fix: NmeaFix) {
        if (!providerAdded) return
        val location = Location(LocationManager.GPS_PROVIDER).apply {
            latitude = fix.latitude
            longitude = fix.longitude
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
    }
}
