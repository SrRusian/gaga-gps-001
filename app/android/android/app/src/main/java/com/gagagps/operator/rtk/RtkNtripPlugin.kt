package com.gagagps.operator.rtk

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

// Puente JS <-> (UsbSerialManager + NtripClient + NmeaParser + MockLocationFeeder + SwMapsOutputServer).
// Este plugin es el unico que conoce todas las piezas a la vez y las conecta: bytes del receptor ->
// NMEA parseado -> mock location + salida SW Maps; RTCM del caster -> bytes al receptor.
@CapacitorPlugin(name = "RtkNtrip")
class RtkNtripPlugin : Plugin() {
    private lateinit var usb: UsbSerialManager
    private lateinit var mockLocation: MockLocationFeeder
    private var ntrip: NtripClient? = null
    private val swMapsServer = SwMapsOutputServer()

    private val usbRate = RateTracker()
    private val ntripRate = RateTracker()
    private val pluginScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var lastFix: NmeaFix? = null
    private var usbConnected = false
    private var ntripConnected = false
    private var ntripError: String? = null
    private var lineBuffer = StringBuilder()

    override fun load() {
        usb = UsbSerialManager(context)
        mockLocation = MockLocationFeeder(context)
        usb.listener = object : UsbSerialManager.Listener {
            override fun onConnected() {
                usbConnected = true
                usbRate.reset() // total acumulado es "de esta conexion", no de toda la vida de la app
                mockLocation.start() // siempre - si ya estaba activo no hace nada
                if (RtkPrefs.getAutoModeEnabled(context)) {
                    val config = RtkPrefs.getNtripConfig(context)
                    if (config != null && config.mountpoint.isNotBlank()) {
                        startNtripInternal(config)
                    }
                }
                emitStatus()
            }
            override fun onDisconnected() {
                usbConnected = false
                // sin receptor no hay nada real que alimentar - se regresa al GPS de la tableta en
                // vez de dejar la ultima posicion RTK "congelada" para siempre
                mockLocation.stop()
                if (ntrip != null) {
                    ntrip?.disconnect()
                    ntrip = null
                    ntripConnected = false
                }
                emitStatus()
            }
            override fun onDataReceived(data: ByteArray) {
                usbRate.addBytes(data.size)
                handleReceiverData(data)
            }
            override fun onError(message: String) {
                ntripError = message
                emitStatus()
            }
            override fun onPermissionDenied() {
                ntripError = "Permiso USB denegado"
                emitStatus()
            }
            override fun onDeviceListChanged() {
                emitUsbDevices()
            }
            override fun onUsbAttached() {
                if (!RtkPrefs.getAutoModeEnabled(context)) return
                if (usb.isConnected()) return
                val drivers = usb.listDevices()
                // prefiere el u-blox si hay varios USB conectados a la vez; si no hay ninguno con
                // ese vendor id (otro modelo de receptor, por ejemplo) usa el primero disponible
                val chosen = drivers.find { it.device.vendorId == RtkPrefs.UBLOX_VENDOR_ID } ?: drivers.firstOrNull()
                chosen?.let { usb.connect(it.device.deviceId, RtkPrefs.getBaudRate(context)) }
            }
        }
    }

    private fun handleReceiverData(data: ByteArray) {
        // el receptor manda NMEA en ASCII linea por linea - se acumula hasta el salto de linea
        lineBuffer.append(String(data, Charsets.ISO_8859_1))
        var newlineIdx: Int
        while (lineBuffer.indexOf("\n").also { newlineIdx = it } >= 0) {
            val line = lineBuffer.substring(0, newlineIdx).trim()
            lineBuffer.delete(0, newlineIdx + 1)
            if (line.isEmpty()) continue

            if (swMapsServer.isRunning) swMapsServer.broadcastLine(line)

            NmeaParser.parseRmc(line)
            val fix = NmeaParser.parseGga(line)
            if (fix != null) {
                lastFix = fix // se guarda igual sin fix (lat/lon null) - para mostrar "buscando satelites"
                if (fix.latitude != null && fix.longitude != null) mockLocation.feed(fix)
            }
        }
        if (lineBuffer.length > 4096) lineBuffer.clear() // basura binaria/UBX, evita crecer sin limite
        // se avisa siempre que llegan bytes (no solo cuando se logra parsear un GGA) - el data
        // rate y el estado de conexion tienen que verse en vivo aunque el receptor mande lineas
        // que no sean GGA, esten incompletas, o todavia no tenga fix
        emitStatus()
    }

    @PluginMethod
    fun listUsbDevices(call: PluginCall) {
        call.resolve(buildUsbDevicesObject())
    }

    private fun buildUsbDevicesObject(): JSObject {
        val arr = JSArray()
        usb.listDevices().forEach { driver ->
            val d = driver.device
            arr.put(
                JSObject()
                    .put("deviceId", d.deviceId)
                    .put("vendorId", d.vendorId)
                    .put("productId", d.productId)
                    .put("name", d.deviceName),
            )
        }
        val ret = JSObject()
        ret.put("devices", arr)
        return ret
    }

    private fun emitUsbDevices() {
        notifyListeners("usbDevicesChanged", buildUsbDevicesObject())
    }

    @PluginMethod
    fun connectUsb(call: PluginCall) {
        val deviceId = call.getInt("deviceId") ?: return call.reject("deviceId requerido")
        val baud = call.getInt("baudRate") ?: RtkPrefs.getBaudRate(context)
        RtkPrefs.setBaudRate(context, baud)
        usb.connect(deviceId, baud)
        call.resolve()
    }

    @PluginMethod
    fun getBaudRate(call: PluginCall) {
        val ret = JSObject()
        ret.put("baudRate", RtkPrefs.getBaudRate(context))
        call.resolve(ret)
    }

    @PluginMethod
    fun setBaudRate(call: PluginCall) {
        val baud = call.getInt("baudRate") ?: return call.reject("baudRate requerido")
        RtkPrefs.setBaudRate(context, baud)
        call.resolve()
    }

    @PluginMethod
    fun disconnectUsb(call: PluginCall) {
        usb.disconnect()
        call.resolve()
    }

    @PluginMethod
    fun setNtripConfig(call: PluginCall) {
        val host = call.getString("host") ?: return call.reject("host requerido")
        val port = call.getInt("port") ?: 2101
        val mountpoint = call.getString("mountpoint") ?: ""
        val username = call.getString("username") ?: ""
        val password = call.getString("password") ?: ""
        val version = NtripVersion.fromKey(call.getString("version"))
        RtkPrefs.setNtripConfig(context, NtripConfig(host, port, mountpoint, username, password, version))
        call.resolve()
    }

    @PluginMethod
    fun getNtripConfig(call: PluginCall) {
        val config = RtkPrefs.getNtripConfig(context)
        val ret = JSObject()
        if (config != null) {
            ret.put("host", config.host)
            ret.put("port", config.port)
            ret.put("mountpoint", config.mountpoint)
            ret.put("username", config.username)
            ret.put("version", config.version.key)
        }
        call.resolve(ret)
    }

    @PluginMethod
    fun getCorrectionMode(call: PluginCall) {
        val ret = JSObject()
        ret.put("mode", RtkPrefs.getCorrectionMode(context).key)
        call.resolve(ret)
    }

    @PluginMethod
    fun setCorrectionMode(call: PluginCall) {
        val mode = call.getString("mode") ?: return call.reject("mode requerido")
        RtkPrefs.setCorrectionMode(context, CorrectionMode.fromKey(mode))
        call.resolve()
    }

    // GET / (sin mountpoint) es un estandar del protocolo NTRIP - cualquier caster real regresa
    // la lista completa de puntos de montura disponibles, no hay que escribirlos a mano
    @PluginMethod
    fun fetchSourceTable(call: PluginCall) {
        val host = call.getString("host") ?: return call.reject("host requerido")
        val port = call.getInt("port") ?: 2101
        pluginScope.launch {
            try {
                val mountpoints = NtripSourceTable.fetch(host, port)
                val arr = JSArray()
                mountpoints.forEach { m ->
                    arr.put(
                        JSObject()
                            .put("mountpoint", m.mountpoint)
                            .put("identifier", m.identifier)
                            .put("format", m.format)
                            .put("navSystem", m.navSystem)
                            .put("country", m.country)
                            .put("latitude", m.latitude)
                            .put("longitude", m.longitude)
                            .put("nmeaRequired", m.nmeaRequired),
                    )
                }
                val ret = JSObject()
                ret.put("mountpoints", arr)
                call.resolve(ret)
            } catch (e: Exception) {
                call.reject("No se pudo obtener la tabla de fuentes: ${e.message}")
            }
        }
    }

    // separado de @PluginMethod startNtrip para que el modo automatico (onConnected(), sin ningun
    // PluginCall a la mano) pueda arrancar NTRIP exactamente igual que si el usuario le diera al boton
    private fun startNtripInternal(config: NtripConfig) {
        ntripRate.reset()

        val client = NtripClient(
            onRtcmData = { bytes ->
                ntripRate.addBytes(bytes.size)
                // si el USB no esta conectado, UsbSerialManager.write() simplemente no hace nada
                // (no truena) - se descarta la correccion en vez de bloquear NTRIP por completo,
                // util para probar el caster/credenciales sin depender de tener el receptor a mano
                if (usb.isConnected()) usb.write(bytes)
            },
            onStatus = { connected, error ->
                ntripConnected = connected
                ntripError = error
                emitStatus()
            },
            currentGga = { null }, // se manda el GGA real del receptor, no uno sintetico
        )
        ntrip = client
        client.connect(config)
    }

    @PluginMethod
    fun startNtrip(call: PluginCall) {
        val config = RtkPrefs.getNtripConfig(context)
            ?: return call.reject("Configura el caster NTRIP primero")
        startNtripInternal(config)
        call.resolve()
    }

    @PluginMethod
    fun getAutoMode(call: PluginCall) {
        val ret = JSObject()
        ret.put("enabled", RtkPrefs.getAutoModeEnabled(context))
        call.resolve(ret)
    }

    @PluginMethod
    fun setAutoMode(call: PluginCall) {
        val enabled = call.getBoolean("enabled") ?: return call.reject("enabled requerido")
        RtkPrefs.setAutoModeEnabled(context, enabled)
        call.resolve()
    }

    @PluginMethod
    fun stopNtrip(call: PluginCall) {
        ntrip?.disconnect()
        ntrip = null
        ntripConnected = false
        emitStatus()
        call.resolve()
    }

    @PluginMethod
    fun startMockLocation(call: PluginCall) {
        val ok = mockLocation.start()
        if (!ok) {
            call.reject(
                "No se pudo activar. Selecciona esta app como 'app de ubicacion simulada' en " +
                    "Opciones de desarrollador > Ubicacion simulada.",
            )
            return
        }
        emitStatus()
        call.resolve()
    }

    @PluginMethod
    fun stopMockLocation(call: PluginCall) {
        mockLocation.stop()
        emitStatus()
        call.resolve()
    }

    @PluginMethod
    fun startSwMapsOutput(call: PluginCall) {
        val port = call.getInt("port") ?: RtkPrefs.getSwMapsPort(context)
        RtkPrefs.setSwMapsPort(context, port)
        try {
            swMapsServer.start(port)
        } catch (e: Exception) {
            return call.reject("No se pudo abrir el puerto $port: ${e.message}")
        }
        emitStatus()
        call.resolve()
    }

    @PluginMethod
    fun stopSwMapsOutput(call: PluginCall) {
        swMapsServer.stop()
        emitStatus()
        call.resolve()
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        call.resolve(buildStatus())
    }

    private fun buildStatus(): JSObject {
        val ret = JSObject()
        ret.put("usbConnected", usbConnected)
        ret.put("connectedUsbDeviceName", usb.connectedDeviceName)
        ret.put("usbDataRateBps", usbRate.currentBytesPerSecond())
        ret.put("usbTotalBytes", usbRate.totalBytes)
        ret.put("ntripConnected", ntripConnected)
        ret.put("ntripError", ntripError)
        ret.put("ntripDataRateBps", ntripRate.currentBytesPerSecond())
        ret.put("ntripTotalBytes", ntripRate.totalBytes)
        ret.put("mockLocationActive", mockLocation.isActive())
        ret.put("swMapsOutputRunning", swMapsServer.isRunning)
        ret.put("swMapsPort", RtkPrefs.getSwMapsPort(context))
        ret.put("correctionMode", RtkPrefs.getCorrectionMode(context).key)
        ret.put("autoModeEnabled", RtkPrefs.getAutoModeEnabled(context))
        val fix = lastFix
        if (fix != null) {
            val fixObj = JSObject()
            fixObj.put("latitude", fix.latitude)
            fixObj.put("longitude", fix.longitude)
            fixObj.put("fixQuality", fix.fixQuality)
            fixObj.put("fixLabel", fix.fixLabel)
            fixObj.put("satellites", fix.satellites)
            fixObj.put("hdop", fix.hdop)
            fixObj.put("accuracyMeters", fix.accuracyMeters)
            ret.put("lastFix", fixObj)
        }
        return ret
    }

    private fun emitStatus() {
        notifyListeners("rtkStatus", buildStatus())
    }
}
