package com.gagagps.operator

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import com.gagagps.operator.kiosk.KioskPrefs
import com.gagagps.operator.traccar.TraccarPrefs
import com.gagagps.operator.traccar.TraccarSenderService
import com.gagagps.operator.update.UpdateScheduler

// Extra sobre resumeTraccarIfNeeded() de MainActivity - eso cubre "cerrar y reabrir la app",
// esto cubre "se reinicio la tableta completa" (Android mata todos los procesos en un reboot,
// sin este receiver el envio se quedaria apagado hasta que alguien abra la app a mano) - y
// tambien "la app se acaba de auto-actualizar sola" (ACTION_MY_PACKAGE_REPLACED, ver
// update/AppUpdateManager.kt), que mata el proceso igual que un reboot para el resto de servicios
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return

        UpdateScheduler.schedule(context)

        if (TraccarPrefs.getAutoStart(context)) {
            val serviceIntent = Intent(context, TraccarSenderService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
        }

        // Bug real reportado: una tableta SIN Modo Kiosko recibio una auto-actualizacion, la app se
        // cerro (Android mata el proceso al reemplazar el APK) y nunca se volvio a abrir sola - el
        // relanzamiento de aqui abajo dependia por completo de KioskPrefs.getEnabled(), que en esa
        // tableta era false. Una auto-actualizacion debe reabrir la app siempre, tenga o no kiosko
        // activo - no hay nadie cerca de la tableta para abrirla a mano. En un reinicio normal de
        // la tableta completa, se mantiene el criterio anterior (solo si el kiosko esta activo,
        // como respaldo de que la app quede registrada como HOME persistente - ver
        // KioskManager.enterKiosk) para no abrir la app sola en una tableta que un tecnico
        // reinicio a proposito para otra cosa.
        val shouldRelaunch = intent.action == Intent.ACTION_MY_PACKAGE_REPLACED || KioskPrefs.getEnabled(context)
        if (shouldRelaunch) {
            val launchIntent = Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(launchIntent)
        }
    }
}
