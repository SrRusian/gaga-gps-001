package com.gaga.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import com.gaga.app.kiosk.KioskPrefs
import com.gaga.app.power.PowerPrefs
import com.gaga.app.traccar.TraccarPrefs
import com.gaga.app.traccar.TraccarSenderService
import com.gaga.app.update.UpdateScheduler

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
        // tableta era false.
        //
        // Segundo bug real reportado (ronda posterior): un reinicio NORMAL de una tableta con Modo
        // Operador activo pero Kiosko todavia apagado tampoco reabria la app - el criterio original
        // era "solo si el kiosko esta activo", pensado para no forzar la app en una tableta que un
        // tecnico reinicio a proposito para otra cosa. En la practica, cualquier tableta con envio
        // continuo activo (TraccarPrefs.getAutoStart) ya esta destinada a operar sola sin
        // supervision, con o sin kiosko - debe reabrirse igual. Sin autoStart ni kiosko (tableta de
        // admin/pruebas sin operar), sigue sin reabrirse sola.
        //
        // Tercer ajuste (pedido explicito): una auto-actualizacion (MY_PACKAGE_REPLACED, nunca un
        // reinicio real) debe respetar como estaba la tableta - si alguien la habia cerrado a
        // proposito (sin kiosko, sin envio continuo, app cerrada), debe seguir cerrada despues de
        // actualizar, no reabrirse sola sin que nadie lo pidiera. AppStatePrefs.getForeground()
        // (MainActivity.onResume/onPause) cubre exactamente ese caso - alguien viendola en el
        // momento de la actualizacion, aunque sea una tableta de pruebas sin kiosko ni autoStart.
        val shouldRelaunch = KioskPrefs.getEnabled(context) ||
            TraccarPrefs.getAutoStart(context) ||
            (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED && AppStatePrefs.getForeground(context))
        if (shouldRelaunch) {
            val launchIntent = Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(launchIntent)
        }

        // respaldo del apagado de WiFi tras la revision de actualizacion de las 2 AM con la
        // tableta suspendida (ver update/AppUpdateManager.kt) - por si el proceso se mato a mitad
        // de esa revision antes de llegar a su propio paso de re-apagarlo. No-op si no aplica
        // (tableta no suspendida, o ya se encargo AppUpdateManager antes de que esto se ejecute).
        if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            PowerPrefs.disableWifiIfStillSuspended(context)
        }
    }
}
