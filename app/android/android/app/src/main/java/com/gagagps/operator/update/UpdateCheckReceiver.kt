package com.gagagps.operator.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import java.util.concurrent.Executors

// disparado por AlarmManager (repetitivo, programado por UpdateScheduler) - goAsync() extiende la
// vida del receiver mientras la descarga corre en un hilo aparte (onReceive nunca puede bloquear
// ni hacer red directamente)
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
                pendingResult.finish()
            }
        }
    }
}
