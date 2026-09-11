package com.gaga.app.update

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
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

    // Bug real confirmado en hardware: la suposicion de que Device Owner esta exento de la
    // restriccion de alarmas exactas de Android 12+ era falsa sin declarar el permiso en el
    // manifest (ver AndroidManifest.xml) - sin el, esto lanzaba SecurityException dentro del hilo
    // de plugins de Capacitor y tumbaba la app COMPLETA en cada arranque (AppUpdatePlugin.configure
    // llama a schedule() al inicializar el plugin). Con el permiso ya declarado esto no deberia
    // volver a pasar, pero se cae a una alarma inexacta en vez de crashear si de todos modos falla
    // (ej. un build viejo instalado antes de este fix, o un fabricante que revoca el permiso) -
    // una revision de actualizacion que llegue con unos minutos de retraso no es grave, un crash si.
    fun schedule(context: Context) {
        val intent = Intent(context, UpdateCheckReceiver::class.java)
        val pendingIntent = PendingIntent.getBroadcast(
            context,
            REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val triggerAt = nextTwoAmMillis()
        val canBeExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms()
        if (canBeExact) {
            try {
                alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent)
                return
            } catch (e: SecurityException) {
                Log.w("UpdateScheduler", "setExactAndAllowWhileIdle rechazado pese al permiso, cae a alarma inexacta", e)
            }
        }
        alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent)
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
