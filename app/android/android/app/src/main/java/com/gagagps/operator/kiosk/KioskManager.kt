package com.gagagps.operator.kiosk

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter

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
}
