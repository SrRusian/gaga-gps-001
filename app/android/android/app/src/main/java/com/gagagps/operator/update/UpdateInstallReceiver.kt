package com.gagagps.operator.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller

// recibe el resultado async de PackageInstaller.Session.commit() - solo registra el error si fallo,
// la reapertura de la app tras una instalacion exitosa la maneja BootReceiver
// (ACTION_MY_PACKAGE_REPLACED), que Android dispara solo cuando la instalacion termina bien
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status != PackageInstaller.STATUS_SUCCESS) {
            val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
            UpdatePrefs.setLastError(context, "Instalacion fallo (status $status): $message")
        }
    }
}
