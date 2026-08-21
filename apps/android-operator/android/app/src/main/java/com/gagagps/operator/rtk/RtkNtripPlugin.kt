package com.gagagps.operator.rtk

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

// Puente JS <-> (UsbSerialManager + NtripClient + NmeaParser + MockLocationFeeder). Este plugin es
// el unico que conoce las 4 piezas a la vez y las conecta: bytes del receptor -> NMEA parseado ->
// mock location; RTCM del caster -> bytes al receptor. Cada pieza por separado no sabe de las otras.
@CapacitorPlugin(name = "RtkNtrip")
class RtkNtripPlugin : Plugin() {
    private lateinit var usb: UsbSerialManager
    private lateinit var mockLocation: MockLocationFeeder
    private var ntrip: NtripClient? = null

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
                emitStatus()
            }
            override fun onDisconnected() {
                usbConnected = false
                emitStatus()
            }
            override fun onDataReceived(data: ByteArray) {
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

            NmeaParser.parseRmc(line)
            val fix = NmeaParser.parseGga(line) ?: continue
            lastFix = fix
            mockLocation.feed(fix)
            emitStatus()
        }
        if (lineBuffer.length > 4096) lineBuffer.clear() // basura binaria/UBX, evita crecer sin limite
    }

    @PluginMethod
    fun listUsbDevices(call: PluginCall) {
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
        call.resolve(ret)
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
        RtkPrefs.setNtripConfig(context, NtripConfig(host, port, mountpoint, username, password))
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
        }
        call.resolve(ret)
    }

    @PluginMethod
    fun startNtrip(call: PluginCall) {
        val config = RtkPrefs.getNtripConfig(context)
            ?: return call.reject("Configura el caster NTRIP primero")
        if (!usb.isConnected()) return call.reject("Conecta el receptor por USB primero")

        val client = NtripClient(
            onRtcmData = { bytes -> usb.write(bytes) },
            onStatus = { connected, error ->
                ntripConnected = connected
                ntripError = error
                emitStatus()
            },
            currentGga = { null }, // se manda el GGA real del receptor, no uno sintetico
        )
        ntrip = client
        client.connect(config)
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
        call.resolve()
    }

    @PluginMethod
    fun stopMockLocation(call: PluginCall) {
        mockLocation.stop()
        call.resolve()
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        call.resolve(buildStatus())
    }

    private fun buildStatus(): JSObject {
        val ret = JSObject()
        ret.put("usbConnected", usbConnected)
        ret.put("ntripConnected", ntripConnected)
        ret.put("ntripError", ntripError)
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
