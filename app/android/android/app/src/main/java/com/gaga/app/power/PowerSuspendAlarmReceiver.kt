package com.gaga.app.power

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.location.LocationManager
import android.net.wifi.WifiManager
import com.gaga.app.kiosk.KioskManager
import com.gaga.app.rtk.RtkNtripPlugin
import com.gaga.app.traccar.TraccarSenderService
import java.util.concurrent.Executors

// dispara 1 minuto despues de perder la corriente, si nadie volvio a conectar el cable antes
// (ver PowerSuspendScheduler). goAsync() porque reportPowerLost() hace red - mismo patron que
// UpdateCheckReceiver, onReceive nunca puede bloquear ni hacer red directamente.
class PowerSuspendAlarmReceiver : BroadcastReceiver() {
    companion object {
        private val executor = Executors.newSingleThreadExecutor()
    }

    override fun onReceive(context: Context, intent: Intent) {
        val pendingResult = goAsync()
        val appContext = context.applicationContext
        executor.execute {
            try {
                enterSuspension(appContext)
            } finally {
                pendingResult.finish()
            }
        }
    }

    private fun enterSuspension(context: Context) {
        // diagnostico del bug real reportado (tarda 26s en vez de 15 configurados) - confirma con
        // numeros reales si la causa es una alarma inexacta (ver PowerSuspendScheduler.schedule)
        // en vez de adivinar
        PowerSuspendScheduler.logActualDelay(context)
        val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val lastFix = try {
            locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER)
        } catch (_: SecurityException) {
            null
        }

        // sin ninguna posicion conocida no hay nada que mandar - de todas formas se suspende
        // (mejor ahorrar bateria que insistir sin datos), simplemente sin el aviso al backend
        if (lastFix != null) {
            PowerEventReporter.reportPowerLost(context, lastFix.latitude, lastFix.longitude)
        }

        PowerPrefs.setSuspended(context, true)
        TraccarSenderService.suspendGps()
        RtkNtripPlugin.suspend()
        // avisa al WebView (useOperatorSocket.ts) ANTES de apagar la pantalla, para que
        // desconecte su socket y corte cualquier alerta ya sonando (clearAlertState()+
        // stopSound()) mientras el WebView sigue activo - bug real en hardware: llamar
        // lockScreenNow() primero dejaba la pantalla apagandose/bloqueandose antes de que el JS
        // alcanzara a correr, y una alerta ya sonando (ej. "sin senal") seguia de fondo
        PowerStatusPlugin.notifyChanged(context)
        // pequena espera para darle tiempo real al WebView de procesar el evento y detener el
        // audio antes de que la pantalla se apague - notifyListeners() despacha al hilo de UI,
        // este hilo (executor de goAsync()) es aparte, no bloquea la UI al dormir aqui
        Thread.sleep(400)
        // apaga la pantalla - sin esto FLAG_KEEP_SCREEN_ON de MainActivity la deja encendida al
        // maximo brillo indefinidamente, justo el consumo que se quiere evitar
        KioskManager.lockScreenNow(context)
        // apaga WiFi al final, ya que todo lo de arriba que necesita red ya se mando -
        // setWifiEnabled() esta bloqueado para apps normales desde Android 10, pero Device Owner
        // esta exento de esa restriccion (confirmado en documentacion oficial de Android). Datos
        // moviles NO se tocan aqui - no existe una API publica confiable para Device Owner que
        // apague datos moviles en general (solo DISALLOW_DATA_ROAMING, que es otra cosa) - en
        // produccion la tableta usa WiFi de todas formas, no datos moviles.
        try {
            val wifiManager = context.applicationContext
                .getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            wifiManager.isWifiEnabled = false
        } catch (_: Exception) {
        }
    }
}
