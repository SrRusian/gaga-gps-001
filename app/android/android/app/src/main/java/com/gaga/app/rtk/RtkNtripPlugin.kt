package com.gaga.app.rtk

import android.Manifest
import android.location.Location
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.ActivityCompat
import com.gaga.app.kiosk.KioskManager
import com.gaga.app.power.PowerPrefs
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
    companion object {
        // referencia al plugin ya cargado - permite que TraccarSenderService (fuera del mundo de
        // plugins de Capacitor) apague/reencienda USB+NTRIP+ubicacion simulada durante la
        // suspension por perdida de corriente (ver power/PowerSuspendAlarmReceiver.kt), sin que
        // ninguno de los dos conozca los detalles internos del otro
        @Volatile private var instance: RtkNtripPlugin? = null

        // margen holgado: a 10Hz de NMEA el enlace va lleno, la respuesta UBX se intercala
        private const val CONFIG_READ_TIMEOUT_MS = 4000L

        // desconectar el transporte ya en cascada apaga mock location y NTRIP (ver
        // onReceiverDisconnected() abajo) - no hace falta duplicar esa logica aqui
        fun suspend() {
            instance?.usb?.disconnect()
            instance?.bt?.disconnect()
        }

        // intenta reconectar al mismo receptor que ya estaba (si sigue ahi) - mismo camino que un
        // attach fisico nuevo o que el modulo Bluetooth volviendo a rango, sin duplicar logica
        fun resume() {
            instance?.connectToAvailableUsbDevice()
            instance?.applyTransportPriority()
        }

        // TraccarSenderService llama esto con el MISMO Location que acaba de mandar al servidor
        // (ver TraccarSenderService.sendLocation) - bug real reportado en campo: el marcador propio
        // del Operador (que usa navigator.geolocation, normalmente resuelto por Fused Location de
        // Play Services - GPS+red combinados) se veia en un punto distinto al que Admin/Supervisor
        // ven desde el servidor (que recibe el GPS_PROVIDER crudo, sin mezcla de red). Emitir el fix
        // exacto que se envia garantiza que coincidan siempre, sin depender de que las dos fuentes
        // de ubicacion independientes del sistema operativo concuerden. useDeviceGeolocation.ts lo
        // trata como una fuente mas (por timestamp, igual que rtkFix) - si RTK ya entrego un fix mas
        // reciente por el canal rapido, este se descarta solo, sin pisar nada.
        fun emitGpsFix(location: Location) {
            val obj = JSObject()
            obj.put("latitude", location.latitude)
            obj.put("longitude", location.longitude)
            if (location.hasSpeed()) obj.put("speedMps", location.speed)
            if (location.hasBearing()) obj.put("courseDeg", location.bearing)
            if (location.hasAccuracy()) obj.put("accuracyMeters", location.accuracy)
            obj.put("timestamp", location.time)
            instance?.notifyListeners("gpsFix", obj)
        }
    }

    private lateinit var usb: UsbSerialManager
    private lateinit var bt: BluetoothSerialManager
    private lateinit var mockLocation: MockLocationFeeder
    private var ntrip: NtripClient? = null
    private val swMapsServer = SwMapsOutputServer()

    private val usbRate = RateTracker()
    private val btRate = RateTracker()
    private val ntripRate = RateTracker()
    private val pluginScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var lastFix: NmeaFix? = null

    // estabiliza la posicion con el vehiculo detenido - se aplica justo antes de que el fix se
    // bifurque hacia el servidor y hacia la pantalla, asi los dos ven exactamente lo mismo
    private val stationaryAnchor = StationaryAnchor()

    // TTFF aproximado: tiempo desde que se establecio ESTE enlace (USB o Bluetooth) hasta el
    // primer fix real. No es el TTFF verdadero de u-blox (que mide desde el power-on del chip via
    // UBX-NAV-STATUS, protocolo binario que no se parsea aqui) - es la mejor aproximacion posible
    // solo con NMEA. Se reinicia en cada conexion nueva (attach fisico, reconexion Bluetooth,
    // cambio de transporte) - un enlace que reconecta rapido mientras el receptor sigue prendido
    // se parece a un TTFF "hot start" real, asi que el numero sigue siendo informativo.
    @Volatile private var connectionStartedAtMs: Long = 0L
    @Volatile private var ttffMs: Long? = null

    // ultima GGA cruda del receptor - el caster la necesita para saber donde estamos (obligatorio
    // en mountpoints VRS/red, que generan una base virtual junto al rover a partir de esto)
    @Volatile private var lastGgaSentence: String? = null
    private var usbConnected = false
    private var btConnected = false
    private var ntripConnected = false
    private var ntripError: String? = null
    // activado solo mientras el menu u-center esta abierto en Ajustes (ver setDiagnosticsActive) -
    // hace que el push "rtkStatus" (ya dispara hasta 10 veces/seg por bloque de bytes) tambien
    // incluya satelites/DOP/TTFF, en vez de solo cuando alguien llama getStatus() a mano. Apagado
    // por default: nadie paga el costo de cruzar la lista de satelites por el puente 10 veces/seg
    // si no hay nada visible que lo necesite. Leido desde el hilo de IO del receptor (USB/BT), sin
    // Looper - @Volatile por la misma razon que shouldStayConnected en los *SerialManager.
    @Volatile private var diagnosticsActive = false
    private var lineBuffer = StringBuilder()

    override fun load() {
        instance = this
        usb = UsbSerialManager(context)
        bt = BluetoothSerialManager(context)
        mockLocation = MockLocationFeeder(context)
        usb.listener = object : UsbSerialManager.Listener {
            override fun onConnected() {
                usbConnected = true
                usbRate.reset() // total acumulado es "de esta conexion", no de toda la vida de la app
                applyTransportPriority()
                onReceiverConnected()
            }
            override fun onDisconnected() {
                usbConnected = false
                applyTransportPriority() // el cable se fue - que retome el Bluetooth
                onReceiverDisconnected()
            }
            override fun onDataReceived(data: ByteArray) {
                usbRate.addBytes(data.size)
                handleReceiverData(data)
            }
            // NO se guarda en ntripError - ese campo es solo del estado real de NTRIP (ver
            // onStatus mas abajo) y se muestra en la tarjeta de NTRIP Client. Un error de
            // transporte (USB desconectado, permiso denegado) ya se refleja con el punto de
            // estado de Receptor - mostrarlo aqui tambien era ruido, y encima aparecia mal
            // etiquetado bajo la tarjeta equivocada. Bug real reportado: el intento automatico de
            // respaldo por Bluetooth (ver applyTransportPriority) fallaba con un mensaje crudo que
            // terminaba en la tarjeta de NTRIP sin relacion alguna con NTRIP.
            override fun onError(message: String) {
                emitStatus()
            }
            override fun onPermissionDenied() {
                emitStatus()
            }
            override fun onDeviceListChanged() {
                emitUsbDevices()
            }
            override fun onUsbAttached() {
                connectToAvailableUsbDevice()
            }
        }
        bt.listener = object : BluetoothSerialManager.Listener {
            override fun onConnected() {
                btConnected = true
                btRate.reset()
                onReceiverConnected()
            }
            override fun onDisconnected() {
                btConnected = false
                onReceiverDisconnected()
            }
            override fun onDataReceived(data: ByteArray) {
                btRate.addBytes(data.size)
                handleReceiverData(data)
            }
            // mismo criterio que el onError de USB de arriba - un error de transporte no es un
            // error de NTRIP, no se guarda en ntripError
            override fun onError(message: String) {
                emitStatus()
            }
            override fun onDeviceListChanged() {
                emitBluetoothDevices()
            }
        }
        // el receptor puede ya estar conectado desde antes de que la app arrancara (reinicio de
        // la app sin mover el cable) - ACTION_USB_DEVICE_ATTACHED solo dispara en un attach fisico
        // nuevo, nunca en este caso. Bug real: sin esto, el auto-conectar (y con el, mock
        // location) se quedaba sin disparar hasta el siguiente desconecta/reconecta fisico del
        // cable - el checklist de "ubicacion simulada" en Ajustes volvia a pedir verificar en
        // cada reapertura de la app aunque el receptor nunca se hubiera movido.
        connectToAvailableUsbDevice()
        // el modulo Bluetooth ya vinculado se toma solo, sin clic ni ajuste (mismo criterio que el
        // USB). En una tableta Device Owner el permiso se concede sin dialogo.
        if (!BluetoothSerialManager.hasConnectPermission(context)) {
            KioskManager.grantSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT)
        }
        applyTransportPriority()
    }

    // El cable manda: menos latencia (~1ms contra 10-40ms de SPP), sin caidas por interferencia de
    // 2.4GHz y mas ancho de banda. Bluetooth es el respaldo automatico. NUNCA los dos a la vez -
    // alimentarian handleReceiverData con el mismo fix dos veces y duplicarian el RTCM de salida.
    private fun applyTransportPriority() {
        if (usb.isConnected()) {
            if (bt.isConnected()) bt.disconnect()
        } else {
            bt.autoConnect()
        }
    }

    // USB y Bluetooth llegan al mismo punto: hay receptor hablando, se enciende todo lo que depende
    // de eso. Idempotente - si los dos estuvieran conectados a la vez no pasa nada raro.
    private fun onReceiverConnected() {
        connectionStartedAtMs = System.currentTimeMillis()
        ttffMs = null
        mockLocation.start() // siempre - si ya estaba activo no hace nada
        // arranca NTRIP solo, siempre - sin flag "modo automatico" que alguien pueda olvidar
        // activar (pedido explicito: el auto-conectar nunca debe ser opcional)
        val config = RtkPrefs.getNtripConfig(context)
        if (config != null && config.mountpoint.isNotBlank() && ntrip == null) {
            startNtripInternal(config)
        }
        emitStatus()
    }

    // solo se apaga si NINGUN transporte queda vivo - sin receptor no hay nada real que alimentar y
    // se regresa al GPS de la tableta, en vez de dejar la ultima posicion RTK congelada para siempre
    private fun onReceiverDisconnected() {
        if (usbConnected || btConnected) {
            emitStatus()
            return
        }
        mockLocation.stop()
        NmeaParser.resetDiagnostics() // sin receptor, los satelites en memoria ya no son reales
        stationaryAnchor.reset() // el vehiculo pudo moverse mientras no habia receptor
        configHandler.post { finishConfigRead(timedOut = true) } // no va a llegar respuesta
        if (ntrip != null) {
            ntrip?.disconnect()
            ntrip = null
            ntripConnected = false
        }
        emitStatus()
    }

    // siempre agarra el receptor solo al detectarlo - sin flag que preguntar, sin clic manual
    // (ver device_filter.xml/AndroidManifest.xml para el permiso USB). Compartido entre el evento
    // de attach fisico y la comprobacion al arrancar la app (ver load()).
    private fun connectToAvailableUsbDevice() {
        if (usb.isConnected()) return
        // En suspension por perdida de corriente NO se reconecta. Sin esto, cualquier evento de
        // attach del USB (o una reapertura de la app) volvia a abrir el puerto, relanzaba NTRIP y
        // la ubicacion simulada, deshaciendo la suspension y dejando al receptor hablando - que es
        // justo lo que mas energia consume de la tableta cuando ya no hay corriente del vehiculo.
        // Al volver la corriente, RtkNtripPlugin.resume() reconecta por el mismo camino.
        if (PowerPrefs.getSuspended(context)) return
        val drivers = usb.listDevices()
        // prefiere el u-blox si hay varios USB conectados a la vez; si no hay ninguno con ese
        // vendor id (otro modelo de receptor, por ejemplo) usa el primero disponible
        val chosen = drivers.find { it.device.vendorId == RtkPrefs.UBLOX_VENDOR_ID } ?: drivers.firstOrNull()
        chosen?.let { usb.connect(it.device.deviceId, RtkPrefs.getBaudRate(context)) }
    }

    private fun handleReceiverData(data: ByteArray) {
        mockLocation.noteReceiverAlive() // llegan bytes = el receptor vive, aunque todavia no tenga fix
        // solo mientras hay una lectura de configuracion en curso - fuera de eso, cero costo
        if (pendingConfigCall != null) feedUbx(data)
        // el receptor manda NMEA en ASCII linea por linea - se acumula hasta el salto de linea
        lineBuffer.append(String(data, Charsets.ISO_8859_1))
        var newlineIdx: Int
        while (lineBuffer.indexOf("\n").also { newlineIdx = it } >= 0) {
            val raw = lineBuffer.substring(0, newlineIdx)
            lineBuffer.delete(0, newlineIdx + 1)
            // el receptor mezcla NMEA (ASCII) con UBX binario en el mismo stream, y un mensaje UBX
            // puede traer un 0x0A que parte la linea a la mitad - se descarta todo lo anterior al
            // ultimo '$' y se ignora cualquier trozo que no traiga ninguno
            val dollarIdx = raw.lastIndexOf('$')
            if (dollarIdx < 0) continue
            val line = raw.substring(dollarIdx).trim()
            if (line.isEmpty()) continue

            if (swMapsServer.isRunning) swMapsServer.broadcastLine(line)

            NmeaParser.parseRmc(line)
            NmeaParser.parseGst(line) // error real del receptor, si GST esta habilitado
            NmeaParser.parseGsa(line) // satelites en uso + DOP
            NmeaParser.parseGsv(line) // satelites a la vista + SNR
            val fix = NmeaParser.parseGga(line)
            if (fix != null) {
                lastFix = fix // se guarda igual sin fix (lat/lon null) - para mostrar "buscando satelites"
                if (fix.latitude != null) lastGgaSentence = line // sin posicion no le sirve al caster
                if (fix.latitude != null && fix.longitude != null) {
                    if (ttffMs == null) ttffMs = System.currentTimeMillis() - connectionStartedAtMs
                    // unico punto donde el fix se bifurca: feed() alimenta GPS_PROVIDER (y de ahi
                    // el envio al servidor) y emitFix() alimenta la pantalla del Operador. El ancla
                    // va aqui para que las dos ramas reciban el mismo valor estabilizado. lastFix
                    // (arriba) queda CRUDO a proposito - u-center es diagnostico, ahi se ve la
                    // medicion real del receptor sin filtrar.
                    val stable = stationaryAnchor.apply(fix)
                    mockLocation.feed(stable)
                    emitFix(stable)
                }
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
                    .put("name", d.friendlyLabel())
                    .put("hasFixedBaud", driver.hasFixedBaud()),
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
        usb.updateBaudRate(baud) // aplica de inmediato si ya hay un puerto USB abierto
        call.resolve()
    }

    @PluginMethod
    fun disconnectUsb(call: PluginCall) {
        usb.disconnect()
        call.resolve()
    }

    @PluginMethod
    fun listBluetoothDevices(call: PluginCall) {
        call.resolve(buildBluetoothDevicesObject())
    }

    private fun buildBluetoothDevicesObject(): JSObject {
        val arr = JSArray()
        bt.listBondedDevices().forEach { device ->
            arr.put(
                JSObject()
                    .put("address", device.address)
                    .put("name", bt.deviceLabel(device))
                    .put("connected", device.address == bt.connectedDeviceAddress),
            )
        }
        val ret = JSObject()
        ret.put("devices", arr)
        return ret
    }

    private fun emitBluetoothDevices() {
        notifyListeners("bluetoothDevicesChanged", buildBluetoothDevicesObject())
    }

    @PluginMethod
    fun connectBluetooth(call: PluginCall) {
        val address = call.getString("address") ?: return call.reject("address requerido")
        bt.connect(address)
        call.resolve()
    }

    @PluginMethod
    fun disconnectBluetooth(call: PluginCall) {
        RtkPrefs.clearBluetoothAddress(context) // sin esto el auto-conectar lo volveria a tomar
        bt.disconnect()
        call.resolve()
    }

    // Device Owner se lo concede solo, sin dialogo; si no lo es, cae al dialogo normal de Android
    @PluginMethod
    fun requestBluetoothPermission(call: PluginCall) {
        if (BluetoothSerialManager.hasConnectPermission(context)) {
            bt.autoConnect()
            return call.resolve()
        }
        if (KioskManager.grantSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT)) {
            bt.autoConnect()
            return call.resolve()
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            activity?.let {
                ActivityCompat.requestPermissions(
                    it, arrayOf(Manifest.permission.BLUETOOTH_CONNECT), 7341,
                )
            }
        }
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
                writeToReceiver(bytes)
            },
            onStatus = { connected, error ->
                ntripConnected = connected
                ntripError = error
                emitStatus()
            },
            currentGga = { lastGgaSentence }, // la GGA real del receptor, nunca una sintetica
        )
        ntrip = client
        client.connect(config)
    }

    // el RTCM va por el transporte que este vivo. Sin ninguno la correccion se descarta sin tronar,
    // util para probar caster/credenciales sin el receptor a la mano.
    private fun writeToReceiver(bytes: ByteArray) {
        if (usb.isConnected()) usb.write(bytes)
        if (bt.isConnected()) bt.write(bytes)
    }

    // ---- Lectura de la configuracion real del receptor (UBX-CFG-VALGET) ----
    // El pipeline normal (handleReceiverData) solo entiende lineas NMEA ASCII y descarta todo lo
    // anterior al ultimo '$', asi que una respuesta UBX binaria se perderia entera. Este buffer
    // paralelo solo se alimenta mientras hay una lectura en curso - fuera de eso no cuesta nada.
    private val configLock = Any()
    private var ubxBuf = ByteArray(0)
    private val configValues = LinkedHashMap<Int, Long>()
    private var expectedKeys: Set<Int> = emptySet()
    @Volatile private var configPortTarget = "UART2"
    @Volatile private var pendingConfigCall: PluginCall? = null
    private val configHandler = Handler(Looper.getMainLooper())
    private val configTimeout = Runnable { finishConfigRead(timedOut = true) }

    private fun feedUbx(data: ByteArray) {
        synchronized(configLock) {
            ubxBuf += data
            // techo duro: si algo sale mal no crece sin limite (mismo criterio que lineBuffer)
            if (ubxBuf.size > 8192) ubxBuf = ubxBuf.copyOfRange(ubxBuf.size - 8192, ubxBuf.size)
            var i = 0
            while (i + 8 <= ubxBuf.size) {
                if ((ubxBuf[i].toInt() and 0xFF) != 0xB5 || (ubxBuf[i + 1].toInt() and 0xFF) != 0x62) {
                    i++
                    continue
                }
                val len = (ubxBuf[i + 4].toInt() and 0xFF) or ((ubxBuf[i + 5].toInt() and 0xFF) shl 8)
                if (len > 4096) { i++; continue } // longitud absurda: no era una trama real
                val end = i + 6 + len + 2
                if (end > ubxBuf.size) break // trama incompleta - esperar mas bytes sin consumirla
                var a = 0
                var b = 0
                for (k in i + 2 until i + 6 + len) {
                    a = (a + (ubxBuf[k].toInt() and 0xFF)) and 0xFF
                    b = (b + a) and 0xFF
                }
                if (a != (ubxBuf[end - 2].toInt() and 0xFF) || b != (ubxBuf[end - 1].toInt() and 0xFF)) {
                    i++ // checksum malo: era un 0xB5 0x62 casual dentro de otra cosa
                    continue
                }
                onUbxFrame(ubxBuf[i + 2].toInt() and 0xFF, ubxBuf[i + 3].toInt() and 0xFF, ubxBuf.copyOfRange(i + 6, i + 6 + len))
                i = end
            }
            if (i > 0) ubxBuf = ubxBuf.copyOfRange(i, ubxBuf.size)
        }
    }

    // corre bajo configLock (llamado desde feedUbx)
    private fun onUbxFrame(cls: Int, id: Int, payload: ByteArray) {
        if (cls != 0x06 || id != 0x8B) return // solo respuestas VALGET
        val values = UbxConfig.parseValgetResponse(payload) ?: return
        configValues.putAll(values)
        if (expectedKeys.isNotEmpty() && configValues.keys.containsAll(expectedKeys)) {
            configHandler.post { finishConfigRead(timedOut = false) }
        }
    }

    private fun finishConfigRead(timedOut: Boolean) {
        val call = pendingConfigCall ?: return
        pendingConfigCall = null
        configHandler.removeCallbacks(configTimeout)
        val snapshot: Map<Int, Long>
        val readKeys: Int
        synchronized(configLock) {
            snapshot = LinkedHashMap(configValues)
            readKeys = expectedKeys.size
            ubxBuf = ByteArray(0)
        }
        if (snapshot.isEmpty()) {
            // ni una sola respuesta: casi siempre es que el puerto no tiene salida UBX habilitada
            call.reject(
                "El receptor no respondio. Si nunca se le aplico la configuracion desde la app, su " +
                    "puerto puede no tener habilitada la salida UBX - aplicala una vez y vuelve a intentar.",
            )
            return
        }
        val decoded = UbxConfig.decodeProvisioning(snapshot, configPortTarget)
        val obj = JSObject()
        for ((field, value) in decoded) {
            if (field == "msgRates") {
                @Suppress("UNCHECKED_CAST")
                val rates = value as List<Map<String, Any>>
                val arr = JSArray()
                for (r in rates) {
                    arr.put(
                        JSObject()
                            .put("message", r["message"] as String)
                            .put("port", r["port"] as String)
                            .put("on", r["on"] as Boolean)
                            .put("value", r["value"] as Int),
                    )
                }
                obj.put("msgRates", arr)
            } else {
                when (value) {
                    is Boolean -> obj.put(field, value)
                    is Long -> obj.put(field, value)
                    else -> obj.put(field, value.toString())
                }
            }
        }
        // parcial = el receptor no contesto todas las claves antes del timeout; la UI avisa en vez
        // de presentar como "leido del receptor" algo que en realidad quedo en su valor anterior
        obj.put("complete", !timedOut && snapshot.size >= readKeys)
        obj.put("readCount", snapshot.size)
        obj.put("expectedCount", readKeys)
        call.resolve(obj)
    }

    // msgRates: mismo patron ya probado en TraccarSenderPlugin.saveServers() - JSArray de objetos
    // en vez de parametros planos, mas manejable para una lista variable (hasta 7 mensajes x 3
    // puertos = 21 entradas) que 42 parametros sueltos. Compartido por escribir y leer, asi las dos
    // operaciones cubren exactamente el mismo conjunto de claves.
    private fun decodeMsgRates(input: JSArray?): List<UbxConfig.MsgRateEntry> {
        val arr = input ?: return UbxConfig.DEFAULT_MSG_RATES
        if (arr.length() == 0) return UbxConfig.DEFAULT_MSG_RATES
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            UbxConfig.MsgRateEntry(
                message = o.getString("message"),
                port = o.getString("port"),
                on = o.optBoolean("on", false),
                value = o.optInt("value", 1),
            )
        }
    }

    // umbral de "detenido" para ESTE vehiculo, derivado de su tipo (ver stationaryThresholdKmh en
    // localSpeed.ts) - 0 lo desactiva, que es lo correcto para maquinaria cuya velocidad de trabajo
    // se confunde con el ruido de medicion
    @PluginMethod
    fun setStationaryThreshold(call: PluginCall) {
        stationaryAnchor.stationarySpeedKmh = (call.getFloat("speedKmh") ?: StationaryAnchor.DEFAULT_STATIONARY_SPEED_KMH)
        call.resolve()
    }

    @PluginMethod
    fun readReceiverConfig(call: PluginCall) {
        if (!usb.isConnected() && !bt.isConnected()) {
            return call.reject("Sin receptor conectado por USB o Bluetooth")
        }
        if (pendingConfigCall != null) {
            return call.reject("Ya hay una lectura de configuracion en curso")
        }
        val portTarget = call.getString("portTarget") ?: "UART2"
        configPortTarget = portTarget
        val msgRates = decodeMsgRates(call.getArray("msgRates"))
        val keys = UbxConfig.provisioningKeys(portTarget, msgRates)
        synchronized(configLock) {
            configValues.clear()
            expectedKeys = keys.toSet()
            ubxBuf = ByteArray(0)
        }
        pendingConfigCall = call
        // el protocolo topa en 64 claves por mensaje - se parte y se juntan las respuestas
        keys.chunked(UbxConfig.MAX_KEYS_PER_MESSAGE).forEach {
            writeToReceiver(UbxConfig.buildValgetRequest(it))
        }
        configHandler.postDelayed(configTimeout, CONFIG_READ_TIMEOUT_MS)
    }

    // Aplica de un solo golpe, desde la tableta, el aprovisionamiento que hasta ahora requeria una
    // PC con u-center (ver UbxConfig.kt y README "Aprovisionamiento de un receptor RTK nuevo") - por
    // USB (bench, receptor recien llegado) o por Bluetooth (HC-05 ya vinculado, receptor ya en el
    // vehiculo), el que este vivo. Sin ninguno conectado no hay a donde mandarlo - se rechaza en vez
    // de fallar en silencio, a diferencia de writeToReceiver() (pensado para RTCM, donde perder un
    // paquete suelto no importa; aqui sí importa que la persona sepa que no se aplico nada).
    @PluginMethod
    fun sendReceiverProvisioning(call: PluginCall) {
        if (!usb.isConnected() && !bt.isConnected()) {
            return call.reject("Sin receptor conectado por USB o Bluetooth")
        }
        val msgRates = decodeMsgRates(call.getArray("msgRates"))
        val frame = UbxConfig.buildF9pAutoProvisioning(
            measRateMs = call.getInt("measRateMs") ?: 100,
            navRateCyc = call.getInt("navRateCyc") ?: 1,
            timeRef = call.getInt("timeRef") ?: 1,
            dynModel = call.getInt("dynModel") ?: 4,
            highPrecision = call.getBoolean("highPrecision", true) ?: true,
            qzssEnabled = call.getBoolean("qzssEnabled", false) ?: false,
            portTarget = call.getString("portTarget") ?: "UART2",
            portBaudRate = call.getInt("portBaudRate") ?: 115200,
            portDatabits = call.getInt("portDatabits") ?: 0,
            portStopbits = call.getInt("portStopbits") ?: 1,
            portParity = call.getInt("portParity") ?: 0,
            portI2cAddress = call.getInt("portI2cAddress") ?: 66,
            portSpiCpol = call.getBoolean("portSpiCpol", false) ?: false,
            portSpiCpha = call.getBoolean("portSpiCpha", false) ?: false,
            portProtocolInUbx = call.getBoolean("portProtocolInUbx", true) ?: true,
            portProtocolInNmea = call.getBoolean("portProtocolInNmea", true) ?: true,
            portProtocolInRtcm3x = call.getBoolean("portProtocolInRtcm3x", true) ?: true,
            portProtocolInSpartn = call.getBoolean("portProtocolInSpartn", false) ?: false,
            portProtocolOutUbx = call.getBoolean("portProtocolOutUbx", false) ?: false,
            portProtocolOutNmea = call.getBoolean("portProtocolOutNmea", true) ?: true,
            portProtocolOutRtcm3x = call.getBoolean("portProtocolOutRtcm3x", false) ?: false,
            // la web siempre manda las 21 combinaciones (7 mensajes x 3 puertos) - un array vacio
            // solo pasaria si alguien llama al plugin sin pasar msgRates en absoluto, en cuyo caso
            // el default del propio buildF9pAutoProvisioning() (GGA/RMC/GLL/GSA/GSV/VTG/GST a 1Hz
            // por UART2, mismo valor que tenia fijo este archivo antes de esta ronda) aplica solo
            msgRates = msgRates.ifEmpty { UbxConfig.DEFAULT_MSG_RATES },
            // vista NMEA (CFG-NMEA-DATA2) - defaults iguales a los del propio buildF9pAutoProvisioning()
            nmeaProtVer = call.getInt("nmeaProtVer") ?: 42,
            nmeaMaxSvs = call.getInt("nmeaMaxSvs") ?: 0,
            nmeaCompat = call.getBoolean("nmeaCompat", false) ?: false,
            nmeaConsider = call.getBoolean("nmeaConsider", true) ?: true,
            nmeaLimit82 = call.getBoolean("nmeaLimit82", false) ?: false,
            nmeaSvNumbering = call.getInt("nmeaSvNumbering") ?: 0,
            nmeaFiltGps = call.getBoolean("nmeaFiltGps", false) ?: false,
            nmeaFiltSbas = call.getBoolean("nmeaFiltSbas", false) ?: false,
            nmeaFiltGal = call.getBoolean("nmeaFiltGal", false) ?: false,
            nmeaFiltQzss = call.getBoolean("nmeaFiltQzss", false) ?: false,
            nmeaFiltGlo = call.getBoolean("nmeaFiltGlo", false) ?: false,
            nmeaFiltBds = call.getBoolean("nmeaFiltBds", false) ?: false,
            nmeaOutInvFix = call.getBoolean("nmeaOutInvFix", false) ?: false,
            nmeaOutMskFix = call.getBoolean("nmeaOutMskFix", false) ?: false,
            nmeaOutInvTime = call.getBoolean("nmeaOutInvTime", false) ?: false,
            nmeaOutInvDate = call.getBoolean("nmeaOutInvDate", false) ?: false,
            nmeaOutOnlyGps = call.getBoolean("nmeaOutOnlyGps", false) ?: false,
            nmeaOutFrozenCog = call.getBoolean("nmeaOutFrozenCog", false) ?: false,
            nmeaMainTalkerId = call.getInt("nmeaMainTalkerId") ?: 0,
            nmeaGsvTalkerId = call.getInt("nmeaGsvTalkerId") ?: 0,
            nmeaBdsTalkerId = call.getString("nmeaBdsTalkerId") ?: "",
            staticHoldSpeedCmS = call.getInt("staticHoldSpeedCmS") ?: 111,
            staticHoldExitDistanceM = call.getInt("staticHoldExitDistanceM") ?: 5,
        )
        writeToReceiver(frame)
        call.resolve()
    }

    @PluginMethod
    fun startNtrip(call: PluginCall) {
        val config = RtkPrefs.getNtripConfig(context)
            ?: return call.reject("Configura el caster NTRIP primero")
        startNtripInternal(config)
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

    // rumbo de la brujula ya corregido por la auto-calibracion de montaje (headingCalibration.ts).
    // El WebView lo empuja ~1/seg; TraccarUplink lo usa como bearing solo cuando el rumbo GPS no es
    // confiable (vehiculo detenido), para que el servidor vea lo mismo que el operador en pantalla.
    @PluginMethod
    fun setCompassHeading(call: PluginCall) {
        val heading = call.getFloat("headingDeg")
        if (heading != null) CompassHeadingHolder.set(heading)
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
        call.resolve(buildStatus(includeSatellites = true))
    }

    // llamado por UCenterView.tsx al abrir/cerrar el overlay - mientras esta activo, el push
    // "rtkStatus" tambien incluye satelites/DOP/TTFF (ver emitStatus()), asi que esos paneles se
    // actualizan al mismo ritmo que la posicion (hasta 10Hz) en vez de solo 1/seg. Fuera de
    // u-center vuelve a apagarse solo, sin que nadie tenga que acordarse.
    @PluginMethod
    fun setDiagnosticsActive(call: PluginCall) {
        diagnosticsActive = call.getBoolean("active", false) ?: false
        call.resolve()
    }

    // la lista de satelites viaja en getStatus (llamado 1/seg fuera de u-center) SIEMPRE, y en el
    // evento rtkStatus (hasta 10 veces por segundo) solo mientras diagnosticsActive este activo -
    // cruzarla por el puente a esa frecuencia sin que nadie la vea seria puro desperdicio
    private fun buildStatus(includeSatellites: Boolean = false): JSObject {
        val ret = JSObject()
        ret.put("usbConnected", usbConnected)
        ret.put("connectedUsbDeviceName", usb.connectedDeviceName)
        ret.put("connectedUsbDeviceId", usb.connectedDeviceId)
        ret.put("usbDataRateBps", usbRate.currentBytesPerSecond())
        ret.put("usbTotalBytes", usbRate.totalBytes)
        ret.put("bluetoothSupported", bt.isSupported())
        ret.put("bluetoothEnabled", bt.isEnabled())
        ret.put("bluetoothPermissionGranted", BluetoothSerialManager.hasConnectPermission(context))
        ret.put("bluetoothConnected", btConnected)
        ret.put("connectedBluetoothName", bt.connectedDeviceName)
        ret.put("connectedBluetoothAddress", bt.connectedDeviceAddress)
        ret.put("bluetoothDataRateBps", btRate.currentBytesPerSecond())
        ret.put("bluetoothTotalBytes", btRate.totalBytes)
        ret.put("ntripConnected", ntripConnected)
        ret.put("ntripError", ntripError)
        ret.put("ntripDataRateBps", ntripRate.currentBytesPerSecond())
        ret.put("ntripTotalBytes", ntripRate.totalBytes)
        ret.put("mockLocationActive", mockLocation.isActive())
        ret.put("mockLocationAllowed", mockLocation.isAllowedByOs())
        ret.put("swMapsOutputRunning", swMapsServer.isRunning)
        ret.put("swMapsPort", RtkPrefs.getSwMapsPort(context))
        ret.put("correctionMode", RtkPrefs.getCorrectionMode(context).key)
        val fix = lastFix
        if (fix != null) {
            val fixObj = JSObject()
            fixObj.put("latitude", fix.latitude)
            fixObj.put("longitude", fix.longitude)
            fixObj.put("altitude", fix.altitude) // MSL, tal cual GGA - nunca viajaba antes por el puente
            fixObj.put("ellipsoidalAltitudeMeters", fix.ellipsoidalAltitudeMeters)
            fixObj.put("gpsTimeMs", fix.gpsTimeMs)
            fix.speedMps?.let { fixObj.put("speedMps", it) }
            fix.courseDeg?.let { fixObj.put("courseDeg", it) }
            fixObj.put("fixQuality", fix.fixQuality)
            fixObj.put("fixLabel", fix.fixLabel)
            fixObj.put("satellites", fix.satellites)
            fixObj.put("hdop", fix.hdop)
            fixObj.put("accuracyMeters", fix.accuracyMeters)
            fixObj.put("horizontalStdMeters", fix.horizontalStdMeters)
            fixObj.put("fullStdMeters", fix.fullStdMeters)
            fixObj.put("correctionAgeSeconds", fix.correctionAgeSeconds)
            fixObj.put("stationId", fix.stationId)
            ret.put("lastFix", fixObj)
        }

        if (includeSatellites) {
            val diag = NmeaParser.diagnostics()
            val arr = JSArray()
            diag.satellites.forEach { s ->
                arr.put(
                    JSObject()
                        .put("constellation", s.constellation)
                        .put("id", s.id)
                        .put("elevation", s.elevation)
                        .put("azimuth", s.azimuth)
                        .put("snr", s.snr)
                        .put("signalId", s.signalId)
                        .put("used", s.used),
                )
            }
            ret.put("satellites", arr)
            ret.put("pdop", diag.pdop)
            ret.put("hdop", diag.hdop)
            ret.put("vdop", diag.vdop)
            ret.put("dimension", diag.dimension)
            ret.put("ttffMs", ttffMs)
        }
        return ret
    }

    private fun emitStatus() {
        notifyListeners("rtkStatus", buildStatus(includeSatellites = diagnosticsActive))
    }

    // evento aparte de "rtkStatus" (que solo se manda al cambiar algo relevante) - este se manda
    // en CADA fix real del receptor, al ritmo que el propio receptor lo entregue (5-10Hz tipico,
    // ver RtkPrefs.DEFAULT_BAUD_RATE) para que la posicion local pueda actualizarse mas rapido que
    // el envio al servidor (siempre a 1/seg, ver TraccarSenderService) sin saturarlo - consumido
    // por useDeviceGeolocation.ts en la web
    private fun emitFix(fix: NmeaFix) {
        val obj = JSObject()
        obj.put("latitude", fix.latitude)
        obj.put("longitude", fix.longitude)
        fix.speedMps?.let { obj.put("speedMps", it) }
        fix.courseDeg?.let { obj.put("courseDeg", it) }
        obj.put("accuracyMeters", fix.accuracyMeters)
        obj.put("timestamp", fix.timestamp)
        notifyListeners("rtkFix", obj)
    }
}
