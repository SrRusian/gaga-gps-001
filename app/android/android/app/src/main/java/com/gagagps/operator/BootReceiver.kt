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

        // con Modo Kiosko activo, la app queda registrada como actividad de inicio (HOME)
        // persistente (ver KioskManager.enterKiosk) - esto es un respaldo explicito para el primer
        // arranque despues de activarlo, por si ese registro todavia no "pego" a tiempo
        if (KioskPrefs.getEnabled(context)) {
            val launchIntent = Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(launchIntent)
        }
    }
}
