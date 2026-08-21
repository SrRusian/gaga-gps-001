package com.gagagps.operator

import android.os.Bundle
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.gagagps.operator.rtk.RtkNtripPlugin
import com.gagagps.operator.traccar.TraccarSenderPlugin
import com.getcapacitor.BridgeActivity

// Tableta montada en el equipo, uso continuo - la barra de estado/navegacion no aporta nada aqui,
// la pantalla no debe apagarse sola, y el brillo debe ser siempre el maximo (visibilidad al sol).
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(TraccarSenderPlugin::class.java)
        registerPlugin(RtkNtripPlugin::class.java)
        super.onCreate(savedInstanceState)
        hideSystemBars()
        keepScreenAwakeAndBright()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
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
}
