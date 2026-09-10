package com.gagagps.operator.kiosk

import android.app.admin.DeviceAdminReceiver

// Requerido por Android para que la app pueda convertirse en Device Owner (dpm set-device-owner) -
// sin logica propia, la activacion real del kiosko (Lock Task Mode, barra de estado, etc.) vive en
// KioskManager. Registrado en AndroidManifest.xml junto con res/xml/device_admin_policies.xml.
class KioskAdminReceiver : DeviceAdminReceiver()
