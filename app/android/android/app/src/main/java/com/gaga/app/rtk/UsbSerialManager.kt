package com.gaga.app.rtk

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.hoho.android.usbserial.driver.CdcAcmSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import com.hoho.android.usbserial.util.SerialInputOutputManager
import java.util.concurrent.Executors

// El ZED-F9P expone su propio puerto USB como CDC-ACM nativo (sin un chip puente FTDI/CP210x/CH340
// detras) - u-center mismo lo confirma: su vista de Ports (PRT) no tiene campo de baud rate cuando
// el target es USB, a diferencia de UART1/UART2, que si lo tienen. El "baud rate" que pide
// UsbSerialPort.setParameters() en ese caso es un parametro USB (SET_LINE_CODING) que el firmware
// del receptor simplemente ignora - no hay ninguna trama serial real detras que framear a esa
// velocidad. Solo importa de verdad con un chip puente real (otro receptor conectado via FTDI/etc).
fun UsbSerialDriver.hasFixedBaud(): Boolean = this is CdcAcmSerialDriver

// nombre amigable para mostrar en la UI - manufacturerName/productName vienen de los descriptores
// USB cacheados por el sistema (no siempre presentes, algunos chips baratos no los declaran), asi
// que cae a "vendor:producto" en hex - nunca a device.deviceName, que es la ruta cruda del nodo
// (/dev/bus/usb/001/002), sin ningun significado para quien solo quiere ver "es este el receptor"
fun UsbDevice.friendlyLabel(): String {
    val parts = listOfNotNull(manufacturerName?.trim(), productName?.trim()).filter { it.isNotBlank() }
    if (parts.isNotEmpty()) return parts.joinToString(" ")
    return "USB %04x:%04x".format(vendorId, productId)
}

// Conexion USB-serial al receptor RTK (chips FTDI/CP210x/CH340/PL2303 - todos soportados por
// usb-serial-for-android). Un receptor RTK conectado por USB se ve como un puerto serial normal,
// no como un dispositivo GNSS especial - por eso esta clase no sabe nada de NMEA/RTCM, solo bytes.
class UsbSerialManager(private val context: Context) {
    companion object {
        private const val ACTION_USB_PERMISSION = "com.gaga.app.rtk.USB_PERMISSION"
        // cadencia normal de reintento, ya avisado "desconectado" de verdad - mismo intervalo que
        // BluetoothSerialManager.RETRY_DELAY_MS
        private const val RETRY_DELAY_MS = 4000L
        // reintento rapido mientras todavia no se avisa "desconectado" (ver DISCONNECT_NOTIFY_GRACE_MS)
        // - cubre el caso real de que el receptor tarde un instante en asentarse justo despues de
        // reconectar, sin esperar los 4s completos
        private const val FAST_RETRY_DELAY_MS = 1000L
        // ventana de gracia antes de avisar "desconectado" de verdad (lo que dispara reiniciar
        // NTRIP/ubicacion simulada en RtkNtripPlugin) - un enlace que se recupera solo dentro de
        // esta ventana nunca llega a avisarse. Bug real de campo: desconectar/reconectar el cable
        // a mano generaba hasta 5 ciclos visibles de conectado/desconectado mientras el receptor
        // se asentaba, cada uno reiniciando NTRIP y ubicacion simulada de mas.
        private const val DISCONNECT_NOTIFY_GRACE_MS = 3000L
    }

    interface Listener {
        fun onConnected()
        fun onDisconnected()
        fun onDataReceived(data: ByteArray)
        fun onError(message: String)
        fun onPermissionDenied()
        fun onDeviceListChanged() {}
        fun onUsbAttached() {} // solo en el momento de conectar (no en desconectar) - para auto-conectar
    }

    private val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
    private var port: UsbSerialPort? = null
    private var ioManager: SerialInputOutputManager? = null
    var listener: Listener? = null

    private val retryHandler = Handler(Looper.getMainLooper())
    @Volatile private var shouldStayConnected = false
    private var lastDeviceId: Int? = null
    private var retryRunnable: Runnable? = null
    // no nulo mientras estamos dentro de DISCONNECT_NOTIFY_GRACE_MS sin haber avisado
    // "desconectado" todavia - tambien senaliza "seguir reintentando rapido" mientras exista
    private var disconnectNotifyRunnable: Runnable? = null

    var connectedDeviceName: String? = null
        private set
    var connectedDeviceId: Int? = null
        private set

    private val permissionReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            if (intent.action != ACTION_USB_PERMISSION) return
            context.unregisterReceiver(this)
            val device = intent.getParcelableExtra<UsbDevice>(UsbManager.EXTRA_DEVICE)
            val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
            if (granted && device != null) {
                openDevice(device)
            } else {
                listener?.onPermissionDenied()
            }
        }
    }

    // deteccion automatica: al conectar/desconectar cualquier USB, avisa para refrescar la lista
    // sola en el front, sin que el usuario tenga que darle "Buscar dispositivos" a mano cada vez.
    // onUsbAttached() solo dispara en el evento de conectar - lo usa RtkNtripPlugin para
    // auto-conectar siempre (no tiene sentido intentar conectar en un evento de detach)
    private val hotplugReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            if (intent.action == UsbManager.ACTION_USB_DEVICE_ATTACHED) {
                listener?.onUsbAttached()
            }
            listener?.onDeviceListChanged()
        }
    }

    init {
        val filter = IntentFilter().apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(hotplugReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            context.registerReceiver(hotplugReceiver, filter)
        }
    }

    fun listDevices(): List<UsbSerialDriver> =
        UsbSerialProber.getDefaultProber().findAllDrivers(usbManager)

    fun connect(deviceId: Int, baudRate: Int) {
        shouldStayConnected = true
        lastDeviceId = deviceId
        cancelPendingDisconnectNotify()
        val driver = listDevices().find { it.device.deviceId == deviceId }
        if (driver == null) {
            listener?.onError("Dispositivo USB no encontrado (desconectado?)")
            return
        }
        pendingBaudRate = baudRate
        val device = driver.device
        if (usbManager.hasPermission(device)) {
            openDevice(device)
            return
        }
        // Android 14+ bloquea FLAG_MUTABLE en un intent implicito (crash real, ya visto en
        // pruebas) - .setPackage() lo vuelve explicito, con eso si se permite mutable, que es
        // obligatorio aqui porque el sistema necesita escribirle EXTRA_DEVICE/EXTRA_PERMISSION_GRANTED
        // al reenviarlo (con FLAG_IMMUTABLE esos extras nunca llegarian)
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        val permissionIntent = PendingIntent.getBroadcast(
            context, 0, Intent(ACTION_USB_PERMISSION).setPackage(context.packageName), flags,
        )
        val filter = IntentFilter(ACTION_USB_PERMISSION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(permissionReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            context.registerReceiver(permissionReceiver, filter)
        }
        usbManager.requestPermission(device, permissionIntent)
    }

    private var pendingBaudRate: Int = RtkPrefs.DEFAULT_BAUD_RATE

    private fun openDevice(device: UsbDevice) {
        val driver = listDevices().find { it.device == device }
        if (driver == null) {
            listener?.onError("Driver USB no disponible para este dispositivo")
            return
        }
        val connection = usbManager.openDevice(driver.device)
        if (connection == null) {
            listener?.onError("No se pudo abrir la conexion USB (revisa el cable/adaptador OTG)")
            return
        }
        val serialPort = driver.ports.firstOrNull()
        if (serialPort == null) {
            listener?.onError("El dispositivo USB no expone un puerto serial")
            return
        }
        try {
            serialPort.open(connection)
            serialPort.setParameters(
                pendingBaudRate,
                UsbSerialPort.DATABITS_8,
                UsbSerialPort.STOPBITS_1,
                UsbSerialPort.PARITY_NONE,
            )
        } catch (e: Exception) {
            listener?.onError("Error abriendo puerto serial: ${e.message}")
            return
        }
        // muchos receptores u-blox se presentan como CDC-ACM y no empiezan a transmitir hasta
        // que el host activa DTR/RTS - sin esto el puerto abre bien pero el receptor se queda
        // callado (confirmado con hardware real: la luz de actividad no prendia sin esto).
        // No todos los drivers soportan estas lineas (algunos FTDI no las necesitan) - no es fatal
        try {
            serialPort.setDTR(true)
            serialPort.setRTS(true)
        } catch (_: Exception) {
        }
        port = serialPort
        cancelPendingDisconnectNotify()
        cancelRetry() // una conexion real ya no necesita ningun reintento huerfano de un ciclo anterior

        val manager = SerialInputOutputManager(
            serialPort,
            object : SerialInputOutputManager.Listener {
                override fun onNewData(data: ByteArray) {
                    listener?.onDataReceived(data)
                }
                override fun onRunError(e: Exception) {
                    handleConnectionLost("Conexion USB perdida: ${e.message}")
                }
            },
        )
        ioManager = manager
        // Este hilo NO debe preparar un Looper. Hubo una version que lo hacia, para callar el error
        // "Can't create handler inside thread ... that has not called Looper.prepare()" que salia
        // como "Conexion USB perdida" - pero ese error nunca fue culpa de la libreria: lo causaba
        // nuestro propio codigo, porque cada fix RTK llega por aqui (onDataReceived -> parseGga ->
        // MockLocationFeeder.feed) y terminaba llamando requestLocationUpdates() desde ESTE hilo.
        // Prepararle un Looper apago el crash y creo algo peor: el listener de ubicacion quedaba
        // registrado contra una cola de mensajes que nunca se vacia (nadie corre Looper.loop()
        // aqui), asi que el GPS dejaba de entregar en silencio, con el servicio vivo. Bug real de
        // campo del 19 sep: 2 horas de viaje sin una sola posicion. La causa se arreglo de raiz en
        // TraccarSenderService.startLocationUpdates() pasando Looper.getMainLooper() explicito.
        // Sin Looper aqui, cualquier reaparicion de ese patron vuelve a fallar RUIDOSAMENTE, que es
        // justo lo que se quiere.
        Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "usb-serial-io") }
            .submit(manager)
        connectedDeviceName = device.friendlyLabel()
        connectedDeviceId = device.deviceId
        listener?.onConnected()
    }

    fun write(data: ByteArray) {
        try {
            port?.write(data, 1000)
        } catch (e: Exception) {
            listener?.onError("Error escribiendo al receptor: ${e.message}")
        }
    }

    // aplica el baud rate a la conexion YA ABIERTA (bug real: antes solo se guardaba en
    // SharedPreferences y recien aplicaba en la siguiente conexion - cambiar el valor con el
    // puerto conectado no hacia nada hasta desconectar y reconectar). Con un puerto CDC-ACM
    // (ver hasFixedBaud()) esto es inofensivo pero no cambia nada real - el firmware lo ignora.
    fun updateBaudRate(baudRate: Int) {
        pendingBaudRate = baudRate
        val openPort = port ?: return
        try {
            openPort.setParameters(baudRate, UsbSerialPort.DATABITS_8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
        } catch (e: Exception) {
            listener?.onError("No se pudo aplicar el baud rate: ${e.message}")
        }
    }

    // detencion intencional (ej. "Desactivar todo" en Ajustes) - a diferencia de un enlace que se
    // cae solo, aqui NO se reintenta despues
    fun disconnect() {
        shouldStayConnected = false
        cancelRetry()
        cancelPendingDisconnectNotify()
        teardown()
        listener?.onDisconnected()
    }

    private fun teardown() {
        ioManager?.stop()
        ioManager = null
        try {
            port?.close()
        } catch (_: Exception) {
        }
        port = null
        connectedDeviceName = null
        connectedDeviceId = null
    }

    // enlace caido con el cable todavia puesto (glitch electrico, timeout de una transferencia) -
    // a diferencia de disconnect() (intencional), aqui SI se reintenta solo, mismo criterio que
    // BluetoothSerialManager.scheduleRetry(). Bug real de campo: RTK vivo, USB fisicamente puesto,
    // tableta sin datos por horas hasta desconectar/reconectar el cable a mano.
    private fun handleConnectionLost(message: String) {
        listener?.onError(message)
        teardown()
        scheduleDisconnectNotifyIfNeeded()
        if (shouldStayConnected) scheduleRetry()
    }

    // avisa "desconectado" de verdad (dispara reiniciar NTRIP/ubicacion simulada en
    // RtkNtripPlugin) solo si el enlace sigue caido pasada DISCONNECT_NOTIFY_GRACE_MS - un fallo
    // que se recupera solo (reintento rapido, o un reattach real del cable) nunca llega a
    // avisarse, asi que nunca reinicia nada de mas
    private fun scheduleDisconnectNotifyIfNeeded() {
        if (disconnectNotifyRunnable != null) return // ya hay uno programado, no reiniciar la cuenta
        val runnable = Runnable {
            disconnectNotifyRunnable = null
            listener?.onDisconnected()
        }
        disconnectNotifyRunnable = runnable
        retryHandler.postDelayed(runnable, DISCONNECT_NOTIFY_GRACE_MS)
    }

    private fun cancelPendingDisconnectNotify() {
        disconnectNotifyRunnable?.let { retryHandler.removeCallbacks(it) }
        disconnectNotifyRunnable = null
    }

    private fun cancelRetry() {
        retryRunnable?.let { retryHandler.removeCallbacks(it) }
        retryRunnable = null
    }

    private fun scheduleRetry() {
        cancelRetry()
        // rapido mientras todavia no se aviso "desconectado" (probablemente el receptor
        // asentandose) - la cadencia normal de 4s solo aplica una vez ya avisado de verdad
        val delay = if (disconnectNotifyRunnable != null) FAST_RETRY_DELAY_MS else RETRY_DELAY_MS
        val runnable = Runnable {
            retryRunnable = null
            retryLastDevice()
        }
        retryRunnable = runnable
        retryHandler.postDelayed(runnable, delay)
    }

    private fun retryLastDevice() {
        if (!shouldStayConnected || isConnected()) return
        val deviceId = lastDeviceId ?: return
        val driver = listDevices().find { it.device.deviceId == deviceId }
        if (driver == null) {
            // el cable de verdad se fue - onUsbAttached() lo retoma solo si vuelve a conectarse
            scheduleRetry()
            return
        }
        val device = driver.device
        if (usbManager.hasPermission(device)) {
            openDevice(device)
        } else {
            // el permiso ya se habia otorgado antes para este mismo dispositivo - si se perdio por
            // algun motivo, reintentar mas tarde en vez de disparar otro dialogo de permiso solo
            scheduleRetry()
        }
    }

    fun isConnected(): Boolean = port != null
}
