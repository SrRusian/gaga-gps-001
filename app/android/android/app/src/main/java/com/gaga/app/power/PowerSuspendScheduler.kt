package com.gaga.app.power

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.util.Log

// temporizador de gracia de 15 segundos EXACTOS tras perder la corriente (pedido explicito del
// usuario - bajado de 30s, que a su vez ya habia bajado de 1 minuto y de 5) - mismo mecanismo de
// AlarmManager ya probado en hardware real para UpdateScheduler. setExactAndAllowWhileIdle() es
// lo mas exacto que Android permite (Device Owner ya tiene SCHEDULE_EXACT_ALARM otorgado solo,
// ver AndroidManifest.xml) - la caida a alarma inexacta de mas abajo solo aplicaria si ese permiso
// llegara a fallar, caso no esperado en este proyecto. schedule() se llama al desconectar el
// cable; cancel() al reconectar antes de que se cumplan los 15s.
object PowerSuspendScheduler {
    private const val REQUEST_CODE = 4230
    private const val GRACE_PERIOD_MS = 15 * 1000L
    private const val TAG = "PowerSuspendScheduler"

    // diagnostico para el bug real reportado (tarda 26s en vez de 15) - guarda a que hora
    // elapsedRealtime() se programo el disparo, para que PowerSuspendAlarmReceiver pueda calcular
    // el desfase real al disparar de verdad, en vez de adivinar. SharedPreferences (no una
    // variable en memoria) por si el proceso muere entre agendar y disparar - elapsedRealtime()
    // sigue siendo valido mientras no haya un reinicio completo de la tableta de por medio.
    private fun prefs(context: Context) = context.getSharedPreferences("gaga_power_suspend_debug", Context.MODE_PRIVATE)

    private fun pendingIntent(context: Context): PendingIntent {
        val intent = Intent(context, PowerSuspendAlarmReceiver::class.java)
        return PendingIntent.getBroadcast(
            context,
            REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    fun schedule(context: Context) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val scheduledAt = SystemClock.elapsedRealtime()
        val triggerAt = scheduledAt + GRACE_PERIOD_MS
        prefs(context).edit().putLong("scheduled_trigger_at", triggerAt).apply()
        val canBeExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms()
        Log.i(TAG, "schedule(): ahora=$scheduledAt, debe disparar en=$triggerAt, canBeExact=$canBeExact")
        if (canBeExact) {
            try {
                alarmManager.setExactAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    triggerAt,
                    pendingIntent(context),
                )
                return
            } catch (e: SecurityException) {
                Log.w(TAG, "setExactAndAllowWhileIdle rechazado, cae a alarma inexacta", e)
            }
        }
        // alarma INEXACTA - Android puede retrasarla varios segundos a proposito (bateria) - si
        // los logs muestran que se esta cayendo aqui, ese es el origen real del desfase reportado
        Log.w(TAG, "usando alarma INEXACTA (canBeExact=$canBeExact) - la suspension puede tardar mas de los 15s")
        alarmManager.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pendingIntent(context))
    }

    fun cancel(context: Context) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarmManager.cancel(pendingIntent(context))
    }

    // llamado desde PowerSuspendAlarmReceiver al disparar de verdad - calcula y loguea el desfase
    // real contra lo que se programo, para diagnosticar sin adivinar
    fun logActualDelay(context: Context) {
        val scheduledTriggerAt = prefs(context).getLong("scheduled_trigger_at", -1L)
        if (scheduledTriggerAt == -1L) return
        val actualDelayMs = SystemClock.elapsedRealtime() - (scheduledTriggerAt - GRACE_PERIOD_MS)
        val lateByMs = SystemClock.elapsedRealtime() - scheduledTriggerAt
        Log.i(TAG, "disparo real: $actualDelayMs ms desde que se perdio la corriente (esperados $GRACE_PERIOD_MS ms, tarde por $lateByMs ms)")
    }
}
