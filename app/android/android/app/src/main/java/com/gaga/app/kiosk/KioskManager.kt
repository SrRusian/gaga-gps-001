package com.gaga.app.kiosk

import android.app.Activity
import android.app.ActivityManager
import android.app.AlarmManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.gaga.app.power.PowerPrefs

// Envuelve las llamadas reales a DevicePolicyManager - todo aqui requiere que la app ya sea
// "Device Owner" (dpm set-device-owner desde una PC con ADB, solo posible en una tableta recien
// reseteada, sin ninguna cuenta de Google agregada - ver app/android/README.md). Sin ese paso,
// enterKiosk()/exitKiosk() no hacen nada (fallan en silencio, isDeviceOwner() ya lo indica en la UI).
object KioskManager {
    private fun adminComponent(context: Context) = ComponentName(context, KioskAdminReceiver::class.java)

    private fun devicePolicyManager(context: Context) =
        context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

    fun isDeviceOwner(context: Context): Boolean = devicePolicyManager(context).isDeviceOwnerApp(context.packageName)

    // ActivityManager.getLockTaskModeState() (no un metodo de Activity, error real encontrado al
    // compilar por primera vez) - unico lugar que expone si Lock Task esta realmente activo ahora
    fun isLockTaskActive(activity: Activity): Boolean {
        val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        return am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
    }

    // deja esta app como la unica autorizada a Lock Task Mode, apaga la barra de estado del todo
    // (mas fuerte que lo que ya bloquea Lock Task Mode por defecto) y se registra como actividad de
    // inicio (HOME) preferida y persistente - asi Android la abre sola despues de cada arranque, sin
    // pasar por el launcher normal de la tableta ni pedir "elegir app de inicio"
    //
    // NO se restringe "Opciones de desarrollador" (UserManager.DISALLOW_DEBUGGING_FEATURES) a
    // proposito - se probo antes y causaba un bug real: esa restriccion apaga TODA la pantalla de
    // Opciones de desarrollador, incluida "Seleccionar app de ubicacion falsa" (confirmado contra
    // documentacion oficial de Android - viven bajo el mismo switch maestro), rompiendo RTK en
    // cuanto se activaba Kiosko. Ademas es redundante para lo que de verdad protege: Lock Task Mode
    // ya impide llegar a Ajustes por completo mientras el kiosko este activo, asi que nadie puede
    // reactivar "Depuracion USB" desde la tableta de todas formas - la unica forma real de tocar
    // Opciones de desarrollador sigue siendo desactivar el kiosko primero con la contrasena.
    fun enterKiosk(activity: Activity, homeActivity: Class<out Activity>) {
        if (!isDeviceOwner(activity)) return
        val dpm = devicePolicyManager(activity)
        val admin = adminComponent(activity)
        dpm.setLockTaskPackages(admin, arrayOf(activity.packageName))
        dpm.setStatusBarDisabled(admin, true)
        val homeFilter = IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_HOME) }
        dpm.addPersistentPreferredActivity(admin, homeFilter, ComponentName(activity, homeActivity))
        if (!isLockTaskActive(activity)) activity.startLockTask()
    }

    // solo se llama desde Ajustes, ya protegido por la contrasena de ajustes existente (ver
    // DeviceSettingsPanel.tsx) - nunca expuesto a un operador normal
    fun exitKiosk(activity: Activity) {
        if (isLockTaskActive(activity)) activity.stopLockTask()
        if (!isDeviceOwner(activity)) return
        val dpm = devicePolicyManager(activity)
        val admin = adminComponent(activity)
        dpm.setStatusBarDisabled(admin, false)
        dpm.clearPackagePersistentPreferredActivities(admin, activity.packageName)
    }

    // Bug real confirmado en hardware (ver PowerSuspendScheduler.kt): la suposicion de que Device
    // Owner recibe SCHEDULE_EXACT_ALARM otorgado solo NO es cierta - verificado contra la
    // documentacion oficial de Android 14 ("Schedule exact alarms are denied by default"), Device
    // Owner NO aparece en la lista de excepciones (solo apps firmadas con el certificado de
    // plataforma, apps privilegiadas, o apps en la lista blanca de optimizacion de bateria). Sin
    // este permiso, `PowerSuspendScheduler`/`UpdateScheduler` caen a alarma inexacta, que Android
    // puede retrasar varios segundos/minutos a proposito - confirmado con log real (26s en vez de
    // 15). Fix real, documentado como unico camino confiable: pedirlo una sola vez con el intent
    // oficial `ACTION_REQUEST_SCHEDULE_EXACT_ALARM` (un tap en Ajustes, no requiere adb ni codigo
    // nuevo cada vez) - mismo patron ya usado para "Opciones de desarrollador"/mock-location.
    fun areExactAlarmsGranted(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        return alarmManager.canScheduleExactAlarms()
    }

    fun openExactAlarmSettings(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        try {
            val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
                data = Uri.parse("package:${context.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
        } catch (_: Exception) {
        }
    }

    // "Opciones de desarrollador" activo - prerequisito real para poder elegir esta app como
    // "ubicacion simulada" (RTK), aunque no tiene relacion directa con Device Owner. Ningun app
    // puede activar esto por su cuenta (proteccion real de Android contra malware) - solo se
    // puede leer el estado y, si ya esta activo, abrir el atajo directo a la pantalla.
    fun isDeveloperOptionsEnabled(context: Context): Boolean =
        Settings.Global.getInt(context.contentResolver, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) != 0

    // intenta abrir directo la pantalla de Opciones de desarrollador (ahi mismo esta "Seleccionar
    // app de ubicacion falsa") - en algunos fabricantes este intent no hace nada si developer
    // options todavia no se activo manualmente (7 toques en "Numero de compilacion"), por eso cae
    // a la pantalla de "Acerca de la tableta" como respaldo, nunca deja al usuario sin ningun lugar
    // donde ir. Sin verificar en hardware real de que fabricante se comporta de que forma.
    fun openDeveloperOptionsOrAbout(context: Context) {
        val devOptionsIntent = Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(devOptionsIntent)
        } catch (_: Exception) {
            val aboutIntent = Intent(Settings.ACTION_DEVICE_INFO_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(aboutIntent)
        }
    }

    // renuncia a Device Owner desde DENTRO de la app - un Device Owner siempre tiene permiso sobre
    // si mismo para esto, sin las restricciones que "adb shell dpm remove-active-admin"/"pm clear"
    // tienen en un build de produccion (ambos confirmados bloqueados en hardware real, ver README).
    // Bug real que motivo esto: sin ninguna forma de liberar Device Owner sin un reseteo de fabrica
    // completo, "reinstalar la app limpia" en una tableta ya aprovisionada no tenia salida. Una vez
    // liberado, la tableta deja de ser kiosko/Device Owner (desinstalable normal desde Ajustes) -
    // hay que volver a correr `dpm set-device-owner` si se quiere recuperar el modo kiosko despues.
    fun releaseDeviceOwner(context: Context): Boolean {
        if (!isDeviceOwner(context)) return true // ya no lo es, nada que liberar
        devicePolicyManager(context).clearDeviceOwnerApp(context.packageName)
        return !isDeviceOwner(context)
    }

    // apaga la pantalla de inmediato (DevicePolicyManager.lockNow(), requiere force-lock en
    // device_admin_policies.xml) - usado al entrar en suspension por perdida de corriente (ver
    // power/PowerSuspendAlarmReceiver.kt). Sin pantalla de bloqueo real configurada ("Ninguno",
    // ver README), esto solo apaga la pantalla, no pide ningun codigo al volver a encenderla.
    fun lockScreenNow(context: Context) {
        if (!isDeviceOwner(context)) return
        try {
            devicePolicyManager(context).lockNow()
        } catch (_: SecurityException) {
        }
    }

    // =========================================================================================
    // INTERACCION FISICA TOTAL DESACTIVADA - todo gobernado por un solo switch (KioskPrefs.getEnabled)
    // =========================================================================================
    // Pedido explicito: mientras Modo Kiosko este activo, NINGUN boton fisico debe poder hacer
    // nada util (ni encender la pantalla suspendida, ni apagarla si esta prendida, ni cambiar
    // volumen) - y todo debe volver a la normalidad de un solo golpe al desactivar el switch, sin
    // que quede ningun candado suelto encendido en otro lado. Las 3 funciones de aqui abajo son el
    // UNICO lugar del proyecto que decide estas reglas - cada punto de entrada de Android que
    // puede disparar un evento de botones (MainActivity.dispatchKeyEvent para volumen,
    // MainActivity.onResume para el boton Home, el receiver de ACTION_SCREEN_ON/OFF en
    // TraccarSenderService para cualquier otro boton fisico) solo LLAMA a una de estas, nunca
    // vuelve a evaluar la condicion por su cuenta. Si algun dia hay que ajustar cuando debe
    // aplicar el bloqueo, este es el unico bloque de codigo que tocar.
    //
    // Nota de diseno importante (confirmada, no tocar sin que se pida de nuevo): estas reglas
    // SOLO controlan botones fisicos/pantalla - nunca deciden nada sobre GPS/RTK/WiFi/sensores.
    // Esos se suspenden exclusivamente en power/PowerSuspendAlarmReceiver.kt, y solo en el
    // instante exacto en que la pantalla se apaga de verdad (pasados los 15s de gracia) - durante
    // esos 15s la tableta sigue funcionando 100% normal, sin ninguna limitacion, a proposito (no
    // tendria sentido perder funciones antes de que la pantalla decida apagarse).

    // volumen - unico boton que Android SI deja consumir de verdad (sin trucos de parpadeo), ver
    // MainActivity.dispatchKeyEvent(). Simplemente sigue al switch, sin ninguna otra condicion -
    // a diferencia de las dos funciones de abajo, el volumen se bloquea con pantalla prendida O
    // apagada, siempre que el kiosko este encendido.
    fun isVolumeLocked(context: Context): Boolean = KioskPrefs.getEnabled(context)

    // pantalla SUSPENDIDA (tableta sin corriente, pasados los 15s) - cualquier boton que logre
    // encenderla por hardware (Home la trae al frente via MainActivity.onResume; cualquier otro
    // via ACTION_SCREEN_ON en TraccarSenderService) se revierte de inmediato. Las DOS condiciones
    // importan: Modo Kiosko encendido Y la tableta realmente suspendida - nunca solo la primera,
    // o la pantalla se re-bloquearia sola tambien durante operacion normal con corriente
    // conectada y el kiosko jamas podria mostrar nada.
    fun enforcePhysicalLockIfSuspended(context: Context) {
        if (KioskPrefs.getEnabled(context) && PowerPrefs.getSuspended(context)) {
            lockScreenNow(context)
        }
    }

    // caso opuesto: pantalla deberia estar ENCENDIDA (kiosko activo, tableta NO suspendida - o
    // sea, operacion normal con corriente), pero algo la apago - en la practica, solo puede ser
    // el boton fisico de encendido/apagado (pedido explicito: evitar que alguien la apague a
    // mano mientras el kiosko este activo). Limite real de Android: ninguna app, ni Device Owner,
    // puede CONSUMIR el evento del boton de encendido en si (a diferencia de volumen) - la unica
    // opcion real es revertirlo de inmediato apenas la pantalla se apague, en vez de evitar el
    // apagon en si. Ver TraccarSenderService (ACTION_SCREEN_OFF) para donde se usa.
    fun shouldForceScreenBackOn(context: Context): Boolean =
        KioskPrefs.getEnabled(context) && !PowerPrefs.getSuspended(context)
}
