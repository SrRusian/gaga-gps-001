package com.gaga.app.kiosk

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import com.gaga.app.MainActivity

// Requerido por Android para que la app pueda convertirse en Device Owner (dpm set-device-owner) -
// sin logica propia mas alla de onProfileProvisioningComplete, la activacion real del kiosko
// (Lock Task Mode, barra de estado, etc.) vive en KioskManager. Registrado en AndroidManifest.xml
// junto con res/xml/device_admin_policies.xml.
class KioskAdminReceiver : DeviceAdminReceiver() {
    // Android llama esto UNA sola vez, justo al terminar el aprovisionamiento por QR/NFC (nunca se
    // dispara con el aprovisionamiento por adb - dpm set-device-owner no pasa por este flujo) -
    // aqui es donde se sabe con certeza que esta tableta se armo via QR, y se deja marcado para que
    // la web (DeviceSettingsPanel.tsx) se salte el codigo de "Modo Operador" y se aprovisione sola
    // al abrir por primera vez, ya que escanear el QR fue en si la decision de dejarla como
    // operador/kiosko - sin verificar en hardware real todavia, este callback nunca se ha
    // disparado en este proyecto (requiere probar con una tableta reseteada de fabrica).
    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        super.onProfileProvisioningComplete(context, intent)
        KioskPrefs.setWasQrProvisioned(context, true)
        val launchIntent = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(launchIntent)
    }
}
