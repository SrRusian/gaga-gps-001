package com.gagagps.operator.update

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import java.util.Calendar

// alarma diaria a las 2 AM (pedido explicito: no interrumpir un vehiculo en operacion durante el
// dia, solo revisar/instalar de madrugada) - un solo disparo por vez (setExactAndAllowWhileIdle no
// se repite solo, UpdateCheckReceiver vuelve a llamar a schedule() al terminar cada revision para
// dejar programado el disparo del dia siguiente). checkAndInstall() ya es un no-op si
// UpdatePrefs.enabled es falso, asi que programar siempre (activado o no) es seguro - no hace
// falta un "cancel" aparte cuando se apaga el switch desde Ajustes.
// "Buscar actualizacion ahora" (manual) y "Actualizar esta tableta"/"todos" (panel Sistema, via
// socket) llaman a AppUpdateManager.checkAndInstall() directo, sin pasar por este horario.
object UpdateScheduler {
    private const val REQUEST_CODE = 4211
    private const val CHECK_HOUR = 2

    // Device Owner esta exento de la restriccion de alarmas exactas de Android 12+ (documentado
    // por Android para dispositivos dedicados) - sin verificar en este proyecto en hardware real
    // todavia, ver app/android/README.md
    fun schedule(context: Context) {
        val intent = Intent(context, UpdateCheckReceiver::class.java)
        val pendingIntent = PendingIntent.getBroadcast(
            context,
            REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, nextTwoAmMillis(), pendingIntent)
    }

    private fun nextTwoAmMillis(): Long {
        val calendar = Calendar.getInstance()
        calendar.set(Calendar.HOUR_OF_DAY, CHECK_HOUR)
        calendar.set(Calendar.MINUTE, 0)
        calendar.set(Calendar.SECOND, 0)
        calendar.set(Calendar.MILLISECOND, 0)
        if (calendar.timeInMillis <= System.currentTimeMillis()) {
            calendar.add(Calendar.DAY_OF_YEAR, 1)
        }
        return calendar.timeInMillis
    }
}
