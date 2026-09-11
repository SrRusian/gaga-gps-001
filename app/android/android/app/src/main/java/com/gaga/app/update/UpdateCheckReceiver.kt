package com.gaga.app.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import java.util.concurrent.Executors

// disparado por la alarma diaria de las 2 AM (programada por UpdateScheduler) - goAsync() extiende
// la vida del receiver mientras la descarga corre en un hilo aparte (onReceive nunca puede
// bloquear ni hacer red directamente). setExactAndAllowWhileIdle() dispara una sola vez, por eso
// se vuelve a programar el siguiente disparo (mañana a las 2 AM) al terminar esta revision.
class UpdateCheckReceiver : BroadcastReceiver() {
    companion object {
        private val executor = Executors.newSingleThreadExecutor()
    }

    override fun onReceive(context: Context, intent: Intent) {
        val pendingResult = goAsync()
        val appContext = context.applicationContext
        executor.execute {
            try {
                AppUpdateManager.checkAndInstall(appContext)
            } finally {
                UpdateScheduler.schedule(appContext)
                pendingResult.finish()
            }
        }
    }
}
