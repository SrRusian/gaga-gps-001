package com.gagagps.operator.update

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

// alarma repetitiva (inexacta - no necesita precision al segundo, ahorra bateria) que dispara
// UpdateCheckReceiver cada INTERVAL_MS. checkAndInstall() ya es un no-op si UpdatePrefs.enabled es
// falso, asi que programar la alarma siempre (habilitado o no) es seguro - no hace falta un
// "cancel" aparte cuando se apaga el switch desde Ajustes
object UpdateScheduler {
    private const val REQUEST_CODE = 4211
    private const val INTERVAL_MS = 6 * 60 * 60 * 1000L // cada 6 horas

    fun schedule(context: Context) {
        val intent = Intent(context, UpdateCheckReceiver::class.java)
        val pendingIntent = PendingIntent.getBroadcast(
            context,
            REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarmManager.setInexactRepeating(
            AlarmManager.RTC_WAKEUP,
            System.currentTimeMillis() + INTERVAL_MS,
            INTERVAL_MS,
            pendingIntent,
        )
    }
}
