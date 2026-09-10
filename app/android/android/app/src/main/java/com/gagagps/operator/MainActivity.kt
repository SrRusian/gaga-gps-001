package com.gagagps.operator

import android.app.KeyguardManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.gagagps.operator.kiosk.KioskManager
import com.gagagps.operator.kiosk.KioskPlugin
import com.gagagps.operator.kiosk.KioskPrefs
import com.gagagps.operator.rtk.RtkNtripPlugin
import com.gagagps.operator.traccar.TraccarPrefs
import com.gagagps.operator.traccar.TraccarSenderPlugin
import com.gagagps.operator.traccar.TraccarSenderService
import com.getcapacitor.BridgeActivity

// Tableta montada en el equipo, uso continuo - la barra de estado/navegacion no aporta nada aqui,
// la pantalla no debe apagarse sola, y el brillo debe ser siempre el maximo (visibilidad al sol).
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(TraccarSenderPlugin::class.java)
        registerPlugin(RtkNtripPlugin::class.java)
        registerPlugin(KioskPlugin::class.java)
        super.onCreate(savedInstanceState)
        hideSystemBars()
        keepScreenAwakeAndBright()
        dismissKeyguard()
        resumeTraccarIfNeeded()
        // Lock Task Mode no sobrevive a que Android mate el proceso - hay que volver a pedirlo en
        // cada arranque real de la Activity (reinicio de tableta, o proceso matado en segundo plano)
        if (KioskPrefs.getEnabled(this)) KioskManager.enterKiosk(this, MainActivity::class.java)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    // Permite que la app se muestre encima de la pantalla de bloqueo y la descarta sola al abrir -
    // SOLO funciona si el bloqueo de la tableta esta en "Ninguno"/"Deslizar" (Ajustes > Pantalla de
    // bloqueo); con PIN/patron/contrasena real, Android SIEMPRE pide el codigo, ninguna app puede
    // saltarselo (proteccion de seguridad real, no un descuido). Es el paso que falta para que el
    // kiosko quede de verdad "cero toques" al recibir corriente del vehiculo.
    private fun dismissKeyguard() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val keyguardManager = getSystemService(KeyguardManager::class.java)
            keyguardManager?.requestDismissKeyguard(this, null)
        }
    }

    // Modo inmersivo "sticky": las barras se ocultan solas, un swipe desde el borde las muestra
    // un momento y se vuelven a ocultar - no bloquea al usuario si de verdad las necesita.
    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    // FLAG_KEEP_SCREEN_ON evita el apagado por inactividad mientras la app este al frente - un
    // press real del boton de encendido SI bloquea la tableta igual, ninguna app puede evitar eso.
    // El brillo se fuerza solo en la ventana de esta app (sin permiso WRITE_SETTINGS, sin tocar el
    // brillo global de Android) - se restaura solo al salir de la app.
    private fun keepScreenAwakeAndBright() {
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val params = window.attributes
        params.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_FULL
        window.attributes = params
    }

    // si la ultima vez que se toco el envio fue "Iniciar", lo retoma solo al abrir la app - asi
    // cerrar/reabrir (o que Android mate el proceso en segundo plano) nunca deja el envio apagado
    // esperando que alguien vuelva a entrar y darle "Iniciar" a mano
    private fun resumeTraccarIfNeeded() {
        if (!TraccarPrefs.getAutoStart(this)) return
        val intent = Intent(this, TraccarSenderService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }
}
