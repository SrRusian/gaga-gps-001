package com.gagagps.operator

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import com.gagagps.operator.traccar.TraccarPrefs
import com.gagagps.operator.traccar.TraccarSenderService

// Extra sobre resumeTraccarIfNeeded() de MainActivity - eso cubre "cerrar y reabrir la app",
// esto cubre "se reinicio la tableta completa" (Android mata todos los procesos en un reboot,
// sin este receiver el envio se quedaria apagado hasta que alguien abra la app a mano)
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (!TraccarPrefs.getAutoStart(context)) return

        val serviceIntent = Intent(context, TraccarSenderService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(serviceIntent)
        } else {
            context.startService(serviceIntent)
        }
    }
}
