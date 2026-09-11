package com.gaga.app.kiosk

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.UserManager
import android.provider.Settings

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
    fun enterKiosk(activity: Activity, homeActivity: Class<out Activity>) {
        if (!isDeviceOwner(activity)) return
        val dpm = devicePolicyManager(activity)
        val admin = adminComponent(activity)
        dpm.setLockTaskPackages(admin, arrayOf(activity.packageName))
        dpm.setStatusBarDisabled(admin, true)
        // bloquea TODA la pantalla de "Opciones de desarrollador" mientras el kiosko este activo -
        // no existe una API mas fina para bloquear solo "seleccionar app de ubicacion falsa", esta
        // es la unica palanca real (ver KioskPlugin/README). Reversible sin adb apagando el kiosko
        // (exitKiosk) - a diferencia de releaseDeviceOwner, que si necesita reaprovisionar.
        dpm.addUserRestriction(admin, UserManager.DISALLOW_DEBUGGING_FEATURES)
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
        dpm.clearUserRestriction(admin, UserManager.DISALLOW_DEBUGGING_FEATURES)
        dpm.clearPackagePersistentPreferredActivities(admin, activity.packageName)
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
}
