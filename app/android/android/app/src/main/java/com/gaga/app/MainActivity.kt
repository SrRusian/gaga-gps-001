package com.gaga.app

import android.app.KeyguardManager
import android.content.Intent
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.gaga.app.kiosk.KioskManager
import com.gaga.app.kiosk.KioskPlugin
import com.gaga.app.kiosk.KioskPrefs
import com.gaga.app.power.PowerStatusPlugin
import com.gaga.app.rtk.RtkNtripPlugin
import com.gaga.app.traccar.TraccarPrefs
import com.gaga.app.traccar.TraccarSenderPlugin
import com.gaga.app.traccar.TraccarSenderService
import com.gaga.app.update.AppUpdatePlugin
import com.getcapacitor.BridgeActivity

// Tableta montada en el equipo, uso continuo - la barra de estado/navegacion no aporta nada aqui,
// la pantalla no debe apagarse sola, y el brillo debe ser siempre el maximo (visibilidad al sol).
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(TraccarSenderPlugin::class.java)
        registerPlugin(RtkNtripPlugin::class.java)
        registerPlugin(KioskPlugin::class.java)
        registerPlugin(AppUpdatePlugin::class.java)
        registerPlugin(PowerStatusPlugin::class.java)
        super.onCreate(savedInstanceState)
        hideSystemBars()
        keepScreenAwakeAndBright()
        forceMaxVolume()
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

    // bug real reportado en campo: con la tableta suspendida por perdida de corriente (ver
    // power/PowerSuspendAlarmReceiver.kt), el boton Home SI encendia la pantalla aunque
    // volumen/encendido/regresar/tareas quedaban correctamente deshabilitados. Causa raiz: Home
    // esta registrado como la unica actividad de inicio del kiosko (addPersistentPreferredActivity
    // en KioskManager.enterKiosk) - presionarlo trae esta Activity de vuelta al frente, y
    // dismissKeyguard() deja la ventana con setTurnScreenOn(true) puesto de forma permanente, asi
    // que recibir foco enciende la pantalla sola, sin pasar por ningun boton fisico real. Fix: en
    // cuanto la Activity vuelve a primer plano, se llama al punto CENTRAL de bloqueo
    // (KioskManager.enforcePhysicalLockIfSuspended - mismo que usa el receiver de
    // ACTION_SCREEN_ON en TraccarSenderService, ninguno de los dos decide la condicion por su
    // cuenta) - mas confiable que solo el receiver porque corre en el mismo ciclo de vida que
    // causa el encendido, sin esperar un broadcast aparte. Ademas, tope de seguridad de 15s
    // (pedido explicito) por si el re-bloqueo inmediato no alcanza a "pegar" por alguna razon no
    // probada en este entorno (sin hardware real aqui).
    private val relockHandler = Handler(Looper.getMainLooper())
    private val relockRunnable = Runnable {
        KioskManager.enforcePhysicalLockIfSuspended(this)
    }

    override fun onResume() {
        super.onResume()
        AppStatePrefs.setForeground(this, true)
        KioskManager.enforcePhysicalLockIfSuspended(this)
        relockHandler.removeCallbacks(relockRunnable)
        relockHandler.postDelayed(relockRunnable, 15_000L)
        // re-afirma el volumen maximo al volver al frente - algo externo (Bluetooth reconectando,
        // etc.) podria haberlo bajado mientras la app no tenia foco
        forceMaxVolume()
    }

    override fun onPause() {
        super.onPause()
        AppStatePrefs.setForeground(this, false)
        relockHandler.removeCallbacks(relockRunnable)
    }

    // bloquea volumen mientras el Modo Kiosko este activo - a diferencia del boton de encendido
    // (KioskManager.shouldForceScreenBackOn, no se puede consumir), volumen SI se puede
    // interceptar de verdad en dispatchKeyEvent: Android lo entrega normal a la Activity en foco,
    // devolver true "consume" el evento y el sistema nunca cambia el volumen. La condicion vive
    // en KioskManager.isVolumeLocked() (punto central de interaccion fisica, ver ese archivo) -
    // aqui solo se llama, nunca se vuelve a decidir.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (KioskManager.isVolumeLocked(this) &&
            (event.keyCode == KeyEvent.KEYCODE_VOLUME_UP || event.keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)
        ) {
            return true
        }
        return super.dispatchKeyEvent(event)
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
    // press real del boton de encendido SI apaga la pantalla igual, ninguna app puede evitar el
    // apagon en si (ver KioskManager.shouldForceScreenBackOn) - con Modo Kiosko activo, ese apagon
    // se revierte de inmediato en vez de evitarse. El brillo se fuerza solo en la ventana de esta
    // app (sin permiso WRITE_SETTINGS, sin tocar el brillo global de Android) - se restaura solo
    // al salir de la app.
    private fun keepScreenAwakeAndBright() {
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val params = window.attributes
        params.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_FULL
        window.attributes = params
    }

    // mismo criterio que el brillo (pedido explicito): la tableta siempre debe escucharse al
    // maximo, para que las alertas de audio (useAlertSound.ts, Web Audio API - sale por
    // STREAM_MUSIC en el WebView) nunca se pierdan por un volumen bajo dejado sin querer. Los
    // botones de volumen ya estan bloqueados con Modo Kiosko (KioskManager.isVolumeLocked), pero
    // esto aplica siempre que la app este abierta, con o sin kiosko - igual que el brillo.
    private fun forceMaxVolume() {
        val audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        val maxVolume = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, maxVolume, 0)
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
