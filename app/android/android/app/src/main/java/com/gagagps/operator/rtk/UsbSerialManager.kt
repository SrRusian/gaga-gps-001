package com.gagagps.operator.rtk

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import com.hoho.android.usbserial.driver.UsbSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import com.hoho.android.usbserial.util.SerialInputOutputManager
import java.util.concurrent.Executors

// Conexion USB-serial al receptor RTK (chips FTDI/CP210x/CH340/PL2303 - todos soportados por
// usb-serial-for-android). Un receptor RTK conectado por USB se ve como un puerto serial normal,
// no como un dispositivo GNSS especial - por eso esta clase no sabe nada de NMEA/RTCM, solo bytes.
class UsbSerialManager(private val context: Context) {
    companion object {
        private const val ACTION_USB_PERMISSION = "com.gagagps.operator.rtk.USB_PERMISSION"
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

    var connectedDeviceName: String? = null
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
    // onUsbAttached() solo dispara en el evento de conectar - lo usa RtkNtripPlugin para el
    // auto-conectar del modo automatico (no tiene sentido intentar conectar en un evento de detach)
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

        val manager = SerialInputOutputManager(
            serialPort,
            object : SerialInputOutputManager.Listener {
                override fun onNewData(data: ByteArray) {
                    listener?.onDataReceived(data)
                }
                override fun onRunError(e: Exception) {
                    listener?.onError("Conexion USB perdida: ${e.message}")
                    disconnect()
                }
            },
        )
        ioManager = manager
        Executors.newSingleThreadExecutor().submit(manager)
        connectedDeviceName = device.deviceName
        listener?.onConnected()
    }

    fun write(data: ByteArray) {
        try {
            port?.write(data, 1000)
        } catch (e: Exception) {
            listener?.onError("Error escribiendo al receptor: ${e.message}")
        }
    }

    fun disconnect() {
        ioManager?.stop()
        ioManager = null
        try {
            port?.close()
        } catch (_: Exception) {
        }
        port = null
        connectedDeviceName = null
        listener?.onDisconnected()
    }

    fun isConnected(): Boolean = port != null
}
