package com.gaga.app.rtk

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.io.OutputStream
import java.util.UUID

// Conexion serial al receptor RTK por Bluetooth (modulo HC-05 sobre SPP), alternativa al cable USB.
// Igual que UsbSerialManager, no sabe nada de NMEA/RTCM - solo bytes en los dos sentidos. El baud
// rate NO se configura aqui: vive entre el HC-05 y el UART2 del receptor, Android solo abre RFCOMM.
@SuppressLint("MissingPermission")
class BluetoothSerialManager(private val context: Context) {
    companion object {
        // UUID estandar de Serial Port Profile, el mismo en todos los modulos HC-05/HC-06
        private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
        private const val RETRY_DELAY_MS = 4000L
        private const val READ_BUFFER_BYTES = 1024

        // Android 12+ exige este permiso en runtime hasta para hablar con un dispositivo ya
        // vinculado; antes BLUETOOTH/BLUETOOTH_ADMIN son de instalacion y no hay nada que pedir
        fun hasConnectPermission(context: Context): Boolean {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
            return context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) ==
                PackageManager.PERMISSION_GRANTED
        }
    }

    interface Listener {
        fun onConnected()
        fun onDisconnected()
        fun onDataReceived(data: ByteArray)
        fun onError(message: String)
        fun onDeviceListChanged() {}
    }

    var listener: Listener? = null

    var connectedDeviceName: String? = null
        private set
    var connectedDeviceAddress: String? = null
        private set

    private val adapter: BluetoothAdapter? =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    private var socket: BluetoothSocket? = null
    private var output: OutputStream? = null
    private val writeLock = Any()
    private val retryHandler = Handler(Looper.getMainLooper())

    @Volatile private var shouldStayConnected = false
    @Volatile private var connecting = false
    @Volatile private var connectedNotified = false

    // el enlace cae solo cuando el vehiculo se apaga o el modulo sale de rango - ACL_CONNECTED avisa
    // que volvio, para reintentar el RFCOMM de inmediato en vez de esperar al reintento programado
    private val aclReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            listener?.onDeviceListChanged()
            if (intent.action == BluetoothDevice.ACTION_ACL_CONNECTED) scheduleRetry(0L)
        }
    }

    init {
        val filter = IntentFilter().apply {
            addAction(BluetoothDevice.ACTION_ACL_CONNECTED)
            addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED)
            addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
            addAction(BluetoothAdapter.ACTION_STATE_CHANGED)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(aclReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            context.registerReceiver(aclReceiver, filter)
        }
    }

    fun isSupported(): Boolean = adapter != null

    fun isEnabled(): Boolean = adapter?.isEnabled == true

    fun isConnected(): Boolean = socket != null

    // solo dispositivos ya vinculados - el emparejamiento se hace en Ajustes de Android (codigo
    // 1234 en el HC-05), asi la app nunca necesita descubrimiento ni BLUETOOTH_SCAN
    fun listBondedDevices(): List<BluetoothDevice> {
        if (!hasConnectPermission(context)) return emptyList()
        return try {
            adapter?.bondedDevices?.toList() ?: emptyList()
        } catch (_: SecurityException) {
            emptyList()
        }
    }

    fun deviceLabel(device: BluetoothDevice): String = try {
        device.name?.takeIf { it.isNotBlank() } ?: device.address
    } catch (_: SecurityException) {
        device.address
    }

    fun connect(address: String) {
        shouldStayConnected = true
        RtkPrefs.setBluetoothAddress(context, address)
        openAsync(address)
    }

    // arranca solo, sin ajuste que alguien pueda dejar apagado - mismo criterio que el USB
    fun autoConnect() {
        if (isConnected() || connecting) return
        val target = RtkPrefs.getBluetoothAddress(context) ?: pickLikelyReceiver()?.address ?: return
        connect(target)
    }

    // sin direccion guardada todavia se elige un modulo serial tipico de entre los ya vinculados -
    // nunca un audifono o teclado que tambien este emparejado
    private fun pickLikelyReceiver(): BluetoothDevice? {
        val bonded = listBondedDevices()
        return bonded.find { device -> deviceLabel(device).uppercase().contains("HC-0") }
            ?: bonded.find { device ->
                val name = deviceLabel(device).uppercase()
                name.contains("RTK") || name.contains("GNSS")
            }
    }

    private fun openAsync(address: String) {
        if (isConnected() || connecting) return
        if (!hasConnectPermission(context)) {
            listener?.onError("Falta el permiso de Bluetooth")
            return
        }
        val bt = adapter
        if (bt == null) {
            listener?.onError("Esta tableta no tiene Bluetooth")
            return
        }
        if (!bt.isEnabled) {
            listener?.onError("El Bluetooth esta apagado")
            scheduleRetry()
            return
        }
        val device = try {
            bt.getRemoteDevice(address)
        } catch (_: IllegalArgumentException) {
            listener?.onError("Direccion Bluetooth invalida: " + address)
            return
        }
        connecting = true
        // hilo propio y SIN Looper, igual que el del USB: si algun dia algo registra un handler
        // desde aqui tiene que fallar ruidosamente, no quedarse mudo (ver UsbSerialManager)
        Thread({ openBlocking(device) }, "bt-serial-io").start()
    }

    private fun openBlocking(device: BluetoothDevice) {
        val sock: BluetoothSocket
        try {
            // NO llamar adapter.cancelDiscovery() aqui: exige BLUETOOTH_SCAN aunque nunca
            // descubramos nada, y su SecurityException se comia el intento de conexion entero
            sock = try {
                device.createRfcommSocketToServiceRecord(SPP_UUID).also { it.connect() }
            } catch (standard: Exception) {
                // algunos equipos no resuelven el SDP de un HC-05 y la via estandar falla siempre;
                // el canal 1 es el que usa SPP
                fallbackRfcomm(device) ?: throw standard
            }
        } catch (e: Exception) {
            connecting = false
            listener?.onError("No se pudo conectar al receptor Bluetooth: " + e.message)
            scheduleRetry()
            return
        }

        socket = sock
        output = sock.outputStream
        connectedDeviceAddress = device.address
        connectedDeviceName = deviceLabel(device)
        connecting = false
        connectedNotified = true
        listener?.onConnected()

        val buffer = ByteArray(READ_BUFFER_BYTES)
        try {
            val input = sock.inputStream
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break // el modulo cerro el enlace
                if (read > 0) listener?.onDataReceived(buffer.copyOf(read))
            }
        } catch (_: Exception) {
            // enlace caido (modulo sin corriente, fuera de rango) - se reintenta abajo
        }

        val intentional = !shouldStayConnected
        closeQuietly()
        notifyDisconnected()
        if (!intentional) scheduleRetry()
    }

    private fun fallbackRfcomm(device: BluetoothDevice): BluetoothSocket? = try {
        val method = device.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
        (method.invoke(device, 1) as BluetoothSocket).also { it.connect() }
    } catch (_: Exception) {
        null
    }

    fun write(data: ByteArray) {
        val out = output ?: return
        synchronized(writeLock) {
            try {
                out.write(data)
                out.flush()
            } catch (e: Exception) {
                listener?.onError("Error escribiendo al receptor Bluetooth: " + e.message)
            }
        }
    }

    fun disconnect() {
        shouldStayConnected = false
        retryHandler.removeCallbacksAndMessages(null)
        closeQuietly()
        notifyDisconnected() // el guard evita que el hilo de lectura vuelva a avisar lo mismo
    }

    private fun notifyDisconnected() {
        if (!connectedNotified) return
        connectedNotified = false
        listener?.onDisconnected()
    }

    private fun scheduleRetry(delayMs: Long = RETRY_DELAY_MS) {
        if (!shouldStayConnected) return
        retryHandler.removeCallbacksAndMessages(null)
        retryHandler.postDelayed({
            val address = RtkPrefs.getBluetoothAddress(context) ?: return@postDelayed
            openAsync(address)
        }, delayMs)
    }

    private fun closeQuietly() {
        try { output?.close() } catch (_: Exception) {}
        try { socket?.close() } catch (_: Exception) {}
        output = null
        socket = null
        connectedDeviceName = null
        connectedDeviceAddress = null
    }
}
