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
    }

    private val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
    private var port: UsbSerialPort? = null
    private var ioManager: SerialInputOutputManager? = null
    var listener: Listener? = null

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
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        val permissionIntent = PendingIntent.getBroadcast(
            context, 0, Intent(ACTION_USB_PERMISSION), flags,
        )
        val filter = IntentFilter(ACTION_USB_PERMISSION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(permissionReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            context.registerReceiver(permissionReceiver, filter)
        }
        usbManager.requestPermission(device, permissionIntent)
    }

    private var pendingBaudRate: Int = 115200

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
        listener?.onDisconnected()
    }

    fun isConnected(): Boolean = port != null
}
