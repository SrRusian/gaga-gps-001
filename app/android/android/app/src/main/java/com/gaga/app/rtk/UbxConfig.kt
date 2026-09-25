package com.gaga.app.rtk

import java.io.ByteArrayOutputStream

// Construye mensajes UBX-CFG-VALSET (0x06 0x8A) - interfaz moderna de configuracion por claves de
// u-blox (protocolo 27+, incluye el ZED-F9P), reemplaza los mensajes legados CFG-RATE/CFG-PRT/
// CFG-NMEA/CFG-NAV5 con pares clave-valor aplicados atomicamente en un solo mensaje. Formato y
// cada key ID verificados contra el manual oficial "u-blox ZED-F9P Interface Description"
// (UBX-18010854-R04): header de 4 bytes (version=0, layers, reserved0 x2) seguido de N pares
// (keyId u4 LE + valor de 1/2/4 bytes segun el bit de tamano codificado en el propio keyId).
// Replica exactamente el procedimiento manual de "Aprovisionamiento de un receptor RTK nuevo"
// (app/android/README.md) que hasta ahora requeria una PC con u-center conectada por USB.
object UbxConfig {
    private const val SYNC1 = 0xB5
    private const val SYNC2 = 0x62
    private const val CLASS_CFG = 0x06
    private const val ID_VALSET = 0x8A

    // layers: aplica YA (RAM) y lo deja sobreviviendo un corte de corriente (BBR+Flash) en el mismo
    // mensaje - sustituye el paso aparte "CFG > Save current configuration" de u-center
    private const val ALL_LAYERS = 0x01 or 0x02 or 0x04

    private fun u1(v: Int) = byteArrayOf(v.toByte())
    private fun u2(v: Int) = byteArrayOf((v and 0xFF).toByte(), ((v shr 8) and 0xFF).toByte())
    private fun u4(v: Int) = byteArrayOf(
        (v and 0xFF).toByte(),
        ((v shr 8) and 0xFF).toByte(),
        ((v shr 16) and 0xFF).toByte(),
        ((v shr 24) and 0xFF).toByte(),
    )
    private fun bool(v: Boolean) = u1(if (v) 1 else 0)
    private fun keyBytes(key: Int) = u4(key)

    private fun checksum(bytes: ByteArray): Pair<Int, Int> {
        var ckA = 0
        var ckB = 0
        for (b in bytes) {
            ckA = (ckA + (b.toInt() and 0xFF)) and 0xFF
            ckB = (ckB + ckA) and 0xFF
        }
        return ckA to ckB
    }

    private fun frame(classId: Int, msgId: Int, payload: ByteArray): ByteArray {
        val header = byteArrayOf(classId.toByte(), msgId.toByte(), (payload.size and 0xFF).toByte(), ((payload.size shr 8) and 0xFF).toByte())
        val (ckA, ckB) = checksum(header + payload)
        val out = ByteArrayOutputStream()
        out.write(SYNC1)
        out.write(SYNC2)
        out.write(header)
        out.write(payload)
        out.write(ckA)
        out.write(ckB)
        return out.toByteArray()
    }

    // maximo 64 pares por mensaje (limite real del protocolo) - muy por debajo del limite util aqui
    private fun valSet(pairs: List<Pair<Int, ByteArray>>): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(0) // version
        out.write(ALL_LAYERS) // layers
        out.write(0) // reserved0
        out.write(0) // reserved0
        for ((key, value) in pairs) {
            out.write(keyBytes(key))
            out.write(value)
        }
        return frame(CLASS_CFG, ID_VALSET, out.toByteArray())
    }

    // pares UBX-<IF>IN|OUTPROT-{UBX,NMEA,RTCM3X,SPARTN} - mismo layout en los 5 interfaces reales
    // (I2C/UART1/UART2/USB/SPI), cada uno con su propio par de bases (IN y OUT van siempre
    // consecutivas: 0x1071/0x1072 I2C, 0x1073/0x1074 UART1, 0x1075/0x1076 UART2, 0x1077/0x1078 USB,
    // 0x1079/0x107A SPI) - confirmado uno por uno contra el manual oficial (re-verificado contra la
    // revision mas reciente, HPG 1.32/UBX-22008968-R01, tras la correccion de NMEA/Galileo/4.11).
    // SPARTN (offset 0x0005, no es bit de mascara - las claves modernas son IDs secuenciales, no un
    // bitmask real) solo existe como protocolo de ENTRADA en los 5 interfaces - ninguna tabla
    // *OUTPROT la lista, por eso `inSpartn` no tiene contraparte de salida.
    private fun protocolKeys(
        inBase: Int,
        outBase: Int,
        inUbx: Boolean,
        inNmea: Boolean,
        inRtcm3x: Boolean,
        inSpartn: Boolean,
        outUbx: Boolean,
        outNmea: Boolean,
        outRtcm3x: Boolean,
    ): List<Pair<Int, ByteArray>> = listOf(
        (inBase or 0x0001) to bool(inUbx),
        (inBase or 0x0002) to bool(inNmea),
        (inBase or 0x0004) to bool(inRtcm3x),
        (inBase or 0x0005) to bool(inSpartn),
        (outBase or 0x0001) to bool(outUbx),
        (outBase or 0x0002) to bool(outNmea),
        (outBase or 0x0004) to bool(outRtcm3x),
    )

    // Vista MSG de u-center real: un mensaje NMEA por fila, cada uno con un checkbox On + un valor
    // (divisor de la epoca de navegacion) POR PUERTO (I2C/UART1/UART2/USB/SPI) - confirmado con
    // capturas reales. Solo se exponen los 7 mensajes que ya usa este proyecto (GGA/RMC/GLL/GSA/
    // GSV/VTG/GST) sobre UART1/UART2/USB (mismo alcance ya decidido para "Puertos" - sin I2C/SPI,
    // hardware real no los usa). Cada clave es CFG-MSGOUT-NMEA_ID_<msg>_<port> - la base de I2C mas
    // un offset fijo por puerto (0=I2C, +1=UART1, +2=UART2, +3=USB, +4=SPI), patron verificado uno
    // por uno contra el manual para los 7 mensajes.
    data class MsgRateEntry(val message: String, val port: String, val on: Boolean, val value: Int)

    // comportamiento de siempre antes de esta ronda: los 7 mensajes a 1Hz por UART2 - default del
    // parametro msgRates de buildF9pAutoProvisioning() y fallback si el puente Capacitor llegara a
    // recibir un array vacio (no deberia pasar, la web siempre manda las 21 combinaciones)
    val DEFAULT_MSG_RATES: List<MsgRateEntry> = listOf(
        MsgRateEntry("GGA", "UART2", on = true, value = 1),
        MsgRateEntry("RMC", "UART2", on = true, value = 1),
        MsgRateEntry("GLL", "UART2", on = true, value = 1),
        MsgRateEntry("GSA", "UART2", on = true, value = 1),
        MsgRateEntry("GSV", "UART2", on = true, value = 1),
        MsgRateEntry("VTG", "UART2", on = true, value = 1),
        MsgRateEntry("GST", "UART2", on = true, value = 1),
    )

    private val NMEA_MSG_I2C_BASE_KEY: Map<String, Int> = mapOf(
        "GGA" to 0x209100ba,
        "RMC" to 0x209100ab,
        "GLL" to 0x209100c9,
        "GSA" to 0x209100bf,
        "GSV" to 0x209100c4,
        "VTG" to 0x209100b0,
        "GST" to 0x209100d3,
    )

    private fun nmeaPortOffset(port: String): Int = when (port) {
        "UART1" -> 1
        "UART2" -> 2
        "USB" -> 3
        else -> 2
    }

    // CFG-NMEA-BDSTALKERID (U2) empaqueta 2 caracteres ASCII, primero en el byte bajo (mismo orden
    // que u2()) - "si se dejan en 0, se usa el Talker ID de BeiDou por defecto" (manual). Cualquier
    // longitud distinta de 2 cae a 0 (default), nunca se manda basura a medias.
    private fun encodeBdsTalkerId(s: String): Int {
        if (s.length != 2) return 0
        return (s[0].code and 0xFF) or ((s[1].code and 0xFF) shl 8)
    }

    // value=0 (apagado) es un estado real y valido de la clave, no un caso especial - un mensaje
    // "Off" en u-center simplemente manda divisor 0 (nunca sale por ese puerto)
    private fun msgRatePairs(entries: List<MsgRateEntry>): List<Pair<Int, ByteArray>> =
        entries.mapNotNull { entry ->
            val base = NMEA_MSG_I2C_BASE_KEY[entry.message] ?: return@mapNotNull null
            val key = base + nmeaPortOffset(entry.port)
            key to u1(if (entry.on) entry.value.coerceIn(0, 255) else 0)
        }

    // Replica el Paso 4 + Paso 5 del README ("Configurar el receptor en u-center" + "Guardar en
    // memoria") en un solo mensaje atomico - si el receptor rechaza una clave, rechaza el mensaje
    // ENTERO (UBX-ACK-NAK), nunca aplica una configuracion a medias. Parametros editables desde el
    // panel "Configuracion del receptor" de u-center (antes venian fijos, pedido explicito: la
    // persona debe poder ajustarlos como en u-center real, no solo aplicar un preset ciego).
    //
    // measRateMs/navRateCyc: los MISMOS dos campos que u-center deja escribir en su vista RATE
    // (Measurement Period / Navigation Rate) - confirmado con captura real de esa vista, donde
    // "Measurement Frequency"/"Navigation Frequency" son solo lectura (calculados, no se mandan).
    // msgRates: la vista MSG real de u-center, un mensaje NMEA por fila con On+valor POR PUERTO
    // (ver msgRatePairs() arriba) - reemplaza el ajuste fijo de GGA/RMC a cada epoca y el resto a
    // ~1Hz que este archivo tenia antes; ahora cada mensaje/puerto se configura tal cual lo decida
    // quien use el panel "Configuracion del receptor".
    // dynModel: constante CFG-NAVSPG-DYNMODEL (0=Portable, 2=Stationary, 3=Pedestrian,
    // 4=Automotive, 5=Sea, 6/7/8=Airborne <1g/<2g/<4g, 9=Wrist watch).
    // highPrecision: NMEA a 7 decimales (0.19mm) en vez de 5 (1.9cm) - ver README "por que importa".
    // qzssEnabled: constelacion regional de Japon, sin uso en Mexico - desactivarla libera canales.
    //
    // portTarget: "I2C" | "UART1" | "UART2" | "USB" | "SPI" - los 5 interfaces reales del ZED-F9P
    // (pedido explicito de ampliar del alcance original de solo UART1/UART2/USB). UART1/UART2 tienen
    // los mismos 4 campos de framing (baud/databits/stopbits/parity); USB no tiene ninguno (no existe
    // ese concepto en un puerto serie virtual); I2C tiene su propio campo (Address, 7 bits); SPI
    // tiene Clock Polarity/Clock Phase (CPOL/CPHA) en vez de baud/databits/stopbits/parity - cada
    // interfaz tiene su propio "framing" real, no un subconjunto del de UART. portDatabits (0=8,
    // 1=7) y portParity (0=None,1=Odd,2=Even) son las UNICAS opciones reales de la clave moderna -
    // u-center (vista legada, generica para toda la familia u-blox) tambien ofrece 5/6 databits y
    // paridad Space/Mark, pero esas NO existen como clave CFG-VALSET en este receptor/firmware, se
    // omiten a proposito en vez de mandar un valor que el receptor va a rechazar - RE-VERIFICADO
    // contra el manual mas reciente (HPG 1.32) tras la correccion de NMEA, sigue sin existir, esta
    // vez no fue un caso de manual desactualizado. portStopbits ahora incluye las 4 constantes reales
    // (0=HALF/0.5, 1=ONE, 2=ONEHALF/1.5, 3=TWO/2.0) - HALF se habia excluido antes sin verificar,
    // corregido. Sin campo de "Bit Order" a proposito - NINGUNA interfaz (ni UART ni SPI) tiene una
    // clave real para eso, re-verificado contra el manual actual (antes se especulaba que SPI si la
    // tenia, resulto ser incorrecto - SPI solo expone CPOL/CPHA, un concepto distinto).
    // portI2cAddress: CFG-I2C-ADDRESS (7 bits), default 66 (0x42, direccion I2C estandar de fabrica
    // de los receptores u-blox). portSpiCpol/portSpiCpha: CFG-SPI-CPOLARITY/CPHASE (booleanos, false
    // = Modo 0 de SPI, el default real).
    // protocolIn gano SPARTN (protocolo de correccion mas nuevo que RTCM3X, solo existe como entrada
    // en los 5 interfaces - ninguna tabla *OUTPROT lo lista). RTCM2/RAW/USER0-3 siguen sin clave
    // moderna, RE-VERIFICADO contra el manual actual y contra el propio mensaje LEGADO UBX-CFG-PRT
    // (su inProtoMask solo define 4 bits reales - UBX/NMEA/RTCM2/RTCM3 - y su outProtoMask solo 3 -
    // UBX/NMEA/RTCM3 - ninguno tiene RAW ni USER0-3, ni en la version actual del firmware) - u-center
    // los sigue mostrando porque su dropdown es generico para toda la familia u-blox que soporta (M8
    // y anteriores si tenian esos bits), no especifico de este ZED-F9P.
    //
    // timeRef: CFG-RATE-TIMEREF (0=UTC, 1=GPS, 2=GLONASS, 3=BeiDou, 4=Galileo, 5=NavIC) - antes
    // fijo a GPS (1) sin poder editarse, ahora expuesto tal cual la vista RATE de u-center real.
    //
    // Vista NMEA de u-center real (CFG-NMEA-DATA2) - 22 campos con clave moderna real. CORRECCION
    // real de una ronda anterior: se habia concluido (con el manual "ZED-F9P Interface Description"
    // UBX-18010854-R04, protocolo 27.12) que "Galileo" en "GNSS to filter out" y el valor "4.11" de
    // NMEA Version NO eran reales - Emmanuel insistio con evidencia (su propio u-center los muestra)
    // y se re-verifico contra el manual mas reciente real (u-blox F9 HPG 1.32 Interface Description,
    // UBX-22008968-R01, protocolo 27.31, descargado de content.u-blox.com) mas la nota de lanzamiento
    // de firmware ZED-F9P HPG 1.13 (UBX-20019211, "CFG_NMEA_PROTVER_V411 added for enabling NMEA
    // 4.11") - CFG-NMEA-FILT_GAL (0x10930013, agregada entre FILT_SBAS y FILT_QZSS) y la constante
    // V411=42 para CFG-NMEA-PROTVER SI son reales, agregadas en firmware posterior al manual R04 que
    // se uso para las rondas RATE/PRT/MSG - ambas confirmadas y ya incluidas abajo. Leccion: el R04
    // es una version fija de la documentacion, no la mas reciente - ante evidencia de hardware real
    // que contradice el manual cacheado, re-verificar contra la version mas nueva antes de descartar.
    // nmeaCompat/nmeaLimit82 son excluyentes con highPrecision (impuesto por el receptor, ver
    // CFG-NMEA-HIGHPREC en el manual) - la UI debe forzar el apagado del otro lado al prender
    // cualquiera de los dos, nunca mandar los tres a la vez.
    // Devuelve los pares clave-valor, no la trama - asi buildF9pAutoProvisioning (escribir) y
    // provisioningKeys (leer de vuelta) salen de la MISMA lista y no se pueden desincronizar.
    fun provisioningPairs(
        measRateMs: Int = 100,
        navRateCyc: Int = 1,
        timeRef: Int = 1,
        dynModel: Int = 4,
        highPrecision: Boolean = true,
        qzssEnabled: Boolean = false,
        portTarget: String = "UART2",
        portBaudRate: Int = 115200,
        portDatabits: Int = 0,
        portStopbits: Int = 1,
        portParity: Int = 0,
        portI2cAddress: Int = 66,
        portSpiCpol: Boolean = false,
        portSpiCpha: Boolean = false,
        portProtocolInUbx: Boolean = true,
        portProtocolInNmea: Boolean = true,
        portProtocolInRtcm3x: Boolean = true,
        portProtocolInSpartn: Boolean = false,
        portProtocolOutUbx: Boolean = true,
        portProtocolOutNmea: Boolean = true,
        portProtocolOutRtcm3x: Boolean = false,
        msgRates: List<MsgRateEntry> = DEFAULT_MSG_RATES,
        // defaults = valores de fabrica reales del receptor (tabla "CFG-NMEA configuration
        // defaults" del manual HPG 1.32) - un dispositivo que nunca toca el panel NMEA manda
        // exactamente lo que ya traia de fabrica, cero sorpresa. nmeaProtVer=42 (V411/NMEA 4.11) es
        // el default real de esta tabla, no 41 (V41/NMEA 4.10) como se penso en la ronda anterior.
        nmeaProtVer: Int = 42,
        nmeaMaxSvs: Int = 0,
        nmeaCompat: Boolean = false,
        nmeaConsider: Boolean = true,
        nmeaLimit82: Boolean = false,
        nmeaSvNumbering: Int = 0,
        nmeaFiltGps: Boolean = false,
        nmeaFiltSbas: Boolean = false,
        nmeaFiltGal: Boolean = false,
        nmeaFiltQzss: Boolean = false,
        nmeaFiltGlo: Boolean = false,
        nmeaFiltBds: Boolean = false,
        nmeaOutInvFix: Boolean = false,
        nmeaOutMskFix: Boolean = false,
        nmeaOutInvTime: Boolean = false,
        nmeaOutInvDate: Boolean = false,
        nmeaOutOnlyGps: Boolean = false,
        nmeaOutFrozenCog: Boolean = false,
        nmeaMainTalkerId: Int = 0,
        nmeaGsvTalkerId: Int = 0,
        nmeaBdsTalkerId: String = "",
        // Static hold: el receptor congela la posicion y pone la velocidad en 0 cuando se detecta
        // detenido. Viene APAGADO de fabrica (0 = comportamiento por defecto = deshabilitado), por
        // eso la posicion vaga estando quieto. Unidad de la clave: cm/s (escala 0.01 m/s), asi que
        // 111 = 4 km/h. La distancia de salida acota cuanto puede equivocarse si algo se mueve de
        // verdad por debajo del umbral de velocidad.
        staticHoldSpeedCmS: Int = 111,
        staticHoldExitDistanceM: Int = 5,
    ): List<Pair<Int, ByteArray>> {
        val clampedMeasRateMs = measRateMs.coerceIn(50, 1000) // 50ms=20Hz, techo real del F9P
        val clampedNavRateCyc = navRateCyc.coerceIn(1, 127) // 127 = maximo real del campo (u-blox)

        val protoPairs = protocolKeys(
            inBase = inProtBase(portTarget),
            outBase = outProtBase(portTarget),
            inUbx = portProtocolInUbx,
            inNmea = portProtocolInNmea,
            inRtcm3x = portProtocolInRtcm3x,
            inSpartn = portProtocolInSpartn,
            outUbx = portProtocolOutUbx,
            outNmea = portProtocolOutNmea,
            outRtcm3x = portProtocolOutRtcm3x,
        )
        // cada interfaz tiene su propio "framing" real - USB no tiene ninguno, I2C tiene Address,
        // SPI tiene Clock Polarity/Phase, solo UART1/UART2 tienen baud/databits/stopbits/parity
        val framingPairs = when (portTarget) {
            "USB" -> emptyList()
            "I2C" -> listOf(
                0x20510001 to u1(portI2cAddress), // CFG-I2C-ADDRESS
            )
            "SPI" -> listOf(
                0x10640002 to bool(portSpiCpol), // CFG-SPI-CPOLARITY
                0x10640003 to bool(portSpiCpha), // CFG-SPI-CPHASE
            )
            "UART1" -> listOf(
                0x40520001 to u4(portBaudRate), // CFG-UART1-BAUDRATE
                0x20520002 to u1(portStopbits), // CFG-UART1-STOPBITS
                0x20520003 to u1(portDatabits), // CFG-UART1-DATABITS
                0x20520004 to u1(portParity), // CFG-UART1-PARITY
            )
            else -> listOf(
                0x40530001 to u4(portBaudRate), // CFG-UART2-BAUDRATE
                0x20530002 to u1(portStopbits), // CFG-UART2-STOPBITS
                0x20530003 to u1(portDatabits), // CFG-UART2-DATABITS
                0x20530004 to u1(portParity), // CFG-UART2-PARITY
            )
        }

        return listOf(
            0x30210001 to u2(clampedMeasRateMs), // CFG-RATE-MEAS
            0x30210002 to u2(clampedNavRateCyc), // CFG-RATE-NAV
            0x20210003 to u1(timeRef), // CFG-RATE-TIMEREF

            0x20930001 to u1(nmeaProtVer), // CFG-NMEA-PROTVER
            0x20930002 to u1(nmeaMaxSvs), // CFG-NMEA-MAXSVS
            0x10930003 to bool(nmeaCompat), // CFG-NMEA-COMPAT: excluyente con HIGHPREC
            0x10930004 to bool(nmeaConsider), // CFG-NMEA-CONSIDER
            0x10930005 to bool(nmeaLimit82), // CFG-NMEA-LIMIT82: excluyente con HIGHPREC
            0x10930006 to bool(highPrecision), // CFG-NMEA-HIGHPREC
            0x20930007 to u1(nmeaSvNumbering), // CFG-NMEA-SVNUMBERING
            0x10930011 to bool(nmeaFiltGps), // CFG-NMEA-FILT_GPS
            0x10930012 to bool(nmeaFiltSbas), // CFG-NMEA-FILT_SBAS
            0x10930013 to bool(nmeaFiltGal), // CFG-NMEA-FILT_GAL
            0x10930015 to bool(nmeaFiltQzss), // CFG-NMEA-FILT_QZSS
            0x10930016 to bool(nmeaFiltGlo), // CFG-NMEA-FILT_GLO
            0x10930017 to bool(nmeaFiltBds), // CFG-NMEA-FILT_BDS
            0x10930021 to bool(nmeaOutInvFix), // CFG-NMEA-OUT_INVFIX
            0x10930022 to bool(nmeaOutMskFix), // CFG-NMEA-OUT_MSKFIX
            0x10930023 to bool(nmeaOutInvTime), // CFG-NMEA-OUT_INVTIME
            0x10930024 to bool(nmeaOutInvDate), // CFG-NMEA-OUT_INVDATE
            0x10930025 to bool(nmeaOutOnlyGps), // CFG-NMEA-OUT_ONLYGPS
            0x10930026 to bool(nmeaOutFrozenCog), // CFG-NMEA-OUT_FROZENCOG
            0x20930031 to u1(nmeaMainTalkerId), // CFG-NMEA-MAINTALKERID
            0x20930032 to u1(nmeaGsvTalkerId), // CFG-NMEA-GSVTALKERID
            0x30930033 to u2(encodeBdsTalkerId(nmeaBdsTalkerId)), // CFG-NMEA-BDSTALKERID

            0x20110021 to u1(dynModel), // CFG-NAVSPG-DYNMODEL

            // "the position output is kept static and the velocity is set to zero until there
            // is evidence of movement again" (ZED-F9P Integration Manual 3.1.8.4) - esto lo
            // hace el motor de navegacion del receptor, con la fase de portadora cruda que
            // nunca sale por NMEA, asi que es exacto de una forma que ningun filtro nuestro
            // puede igualar. StationaryAnchor.kt queda como respaldo del lado Android.
            0x20250038 to u1(staticHoldSpeedCmS.coerceIn(0, 255)), // CFG-MOT-GNSSSPEED_THRS
            0x3025003b to u2(staticHoldExitDistanceM.coerceIn(0, 65535)), // CFG-MOT-GNSSDIST_THRS

            // SBAS NO se toca aqui - el protocolo moderno de claves no expone un
            // CFG-SIGNAL-SBAS_ENA en este receptor/firmware; la unica via es el mensaje legado
            // UBX-CFG-GNSS (bloques de tamano variable, requiere leer la configuracion actual
            // antes de modificarla) - se dejo fuera a proposito, ver README. Deshabilitar SBAS
            // sigue siendo manual desde u-center si se quiere ese canal libre.
            0x10310024 to bool(qzssEnabled), // CFG-SIGNAL-QZSS_ENA
        ) + protoPairs + framingPairs + msgRatePairs(msgRates)
    }

    // Envuelve los pares en el VALSET real. Se separo de provisioningPairs para que la lectura de
    // vuelta (provisioningKeys) use exactamente la misma lista sin poder desincronizarse.
    fun buildF9pAutoProvisioning(
        measRateMs: Int = 100,
        navRateCyc: Int = 1,
        timeRef: Int = 1,
        dynModel: Int = 4,
        highPrecision: Boolean = true,
        qzssEnabled: Boolean = false,
        portTarget: String = "UART2",
        portBaudRate: Int = 115200,
        portDatabits: Int = 0,
        portStopbits: Int = 1,
        portParity: Int = 0,
        portI2cAddress: Int = 66,
        portSpiCpol: Boolean = false,
        portSpiCpha: Boolean = false,
        portProtocolInUbx: Boolean = true,
        portProtocolInNmea: Boolean = true,
        portProtocolInRtcm3x: Boolean = true,
        portProtocolInSpartn: Boolean = false,
        // TRUE por default desde que existe la lectura de configuracion: sin salida UBX habilitada
        // el receptor no puede contestar un VALGET ni mandar ACK/NAK, asi que el panel no tendria
        // de donde leer. No cuesta ancho de banda: los mensajes UBX periodicos siguen apagados
        // (eso lo decide CFG-MSGOUT-*), esto solo permite que salgan respuestas a lo que se pide.
        portProtocolOutUbx: Boolean = true,
        portProtocolOutNmea: Boolean = true,
        portProtocolOutRtcm3x: Boolean = false,
        msgRates: List<MsgRateEntry> = DEFAULT_MSG_RATES,
        nmeaProtVer: Int = 42,
        nmeaMaxSvs: Int = 0,
        nmeaCompat: Boolean = false,
        nmeaConsider: Boolean = true,
        nmeaLimit82: Boolean = false,
        nmeaSvNumbering: Int = 0,
        nmeaFiltGps: Boolean = false,
        nmeaFiltSbas: Boolean = false,
        nmeaFiltGal: Boolean = false,
        nmeaFiltQzss: Boolean = false,
        nmeaFiltGlo: Boolean = false,
        nmeaFiltBds: Boolean = false,
        nmeaOutInvFix: Boolean = false,
        nmeaOutMskFix: Boolean = false,
        nmeaOutInvTime: Boolean = false,
        nmeaOutInvDate: Boolean = false,
        nmeaOutOnlyGps: Boolean = false,
        nmeaOutFrozenCog: Boolean = false,
        nmeaMainTalkerId: Int = 0,
        nmeaGsvTalkerId: Int = 0,
        nmeaBdsTalkerId: String = "",
        staticHoldSpeedCmS: Int = 111,
        staticHoldExitDistanceM: Int = 5,
    ): ByteArray = valSet(
        provisioningPairs(
            measRateMs, navRateCyc, timeRef, dynModel, highPrecision, qzssEnabled,
            portTarget, portBaudRate, portDatabits, portStopbits, portParity,
            portI2cAddress, portSpiCpol, portSpiCpha,
            portProtocolInUbx, portProtocolInNmea, portProtocolInRtcm3x, portProtocolInSpartn,
            portProtocolOutUbx, portProtocolOutNmea, portProtocolOutRtcm3x,
            msgRates, nmeaProtVer, nmeaMaxSvs, nmeaCompat, nmeaConsider, nmeaLimit82,
            nmeaSvNumbering, nmeaFiltGps, nmeaFiltSbas, nmeaFiltGal, nmeaFiltQzss,
            nmeaFiltGlo, nmeaFiltBds, nmeaOutInvFix, nmeaOutMskFix, nmeaOutInvTime,
            nmeaOutInvDate, nmeaOutOnlyGps, nmeaOutFrozenCog, nmeaMainTalkerId,
            nmeaGsvTalkerId, nmeaBdsTalkerId, staticHoldSpeedCmS, staticHoldExitDistanceM,
        ),
    )

    // ---- Lectura de la configuracion REAL del receptor (UBX-CFG-VALGET, 0x06 0x8B) ----
    // Sin esto el panel de configuracion mostraba siempre los defaults del codigo, asi que darle
    // "Aplicar" sobreescribia lo que el receptor de verdad tuviera. Formato verificado contra el
    // manual HPG 1.32 (3.10.25): peticion version=0x00 + layer + position(u2) + N claves u4 (max
    // 64); respuesta version=0x01 + misma cabecera de 4 bytes + pares clave-valor codificados
    // igual que en VALSET.
    private const val ID_VALGET = 0x8B

    const val LAYER_RAM = 0
    const val LAYER_FLASH = 2

    // tamano del valor en bytes, codificado en el propio key ID (bits 28-30) - misma tabla que usa
    // u-blox para todas sus claves: 1=bit, 2=1 byte, 3=2 bytes, 4=4 bytes, 5=8 bytes
    fun valueSize(key: Int): Int = when ((key ushr 28) and 0x07) {
        0x01, 0x02 -> 1
        0x03 -> 2
        0x04 -> 4
        0x05 -> 8
        else -> 0 // clave con tamano desconocido - no se puede seguir leyendo el resto del payload
    }

    fun buildValgetRequest(keys: List<Int>, layer: Int = LAYER_RAM): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(0) // version = 0x00 (peticion)
        out.write(layer)
        out.write(0) // position (u2) - sin paginar, pedimos claves explicitas
        out.write(0)
        for (key in keys.take(MAX_KEYS_PER_MESSAGE)) out.write(keyBytes(key))
        return frame(CLASS_CFG, ID_VALGET, out.toByteArray())
    }

    // devuelve null si el payload no es una respuesta VALGET valida (version != 1) o si trae una
    // clave de tamano desconocido - en ese caso no se puede saber donde empieza la siguiente, asi
    // que se corta en vez de devolver datos corridos
    fun parseValgetResponse(payload: ByteArray): Map<Int, Long>? {
        if (payload.size < 4 || (payload[0].toInt() and 0xFF) != 0x01) return null
        val values = LinkedHashMap<Int, Long>()
        var i = 4
        while (i + 4 <= payload.size) {
            val key = (payload[i].toInt() and 0xFF) or
                ((payload[i + 1].toInt() and 0xFF) shl 8) or
                ((payload[i + 2].toInt() and 0xFF) shl 16) or
                ((payload[i + 3].toInt() and 0xFF) shl 24)
            val size = valueSize(key)
            if (size == 0 || i + 4 + size > payload.size) break
            var v = 0L
            for (b in 0 until size) v = v or ((payload[i + 4 + b].toLong() and 0xFF) shl (8 * b))
            values[key] = v
            i += 4 + size
        }
        return values
    }

    // Las claves que el panel sabe leer/escribir, derivadas de la MISMA lista que se escribe - no
    // una segunda lista que se pueda desincronizar. Los valores son irrelevantes aqui, solo importan
    // las claves, por eso se llama con los defaults.
    fun provisioningKeys(portTarget: String, msgRates: List<MsgRateEntry> = DEFAULT_MSG_RATES): List<Int> =
        provisioningPairs(portTarget = portTarget, msgRates = msgRates).map { it.first }

    const val MAX_KEYS_PER_MESSAGE = 64

    // Traduce el mapa crudo clave->valor que devolvio el receptor a la MISMA forma que la UI ya
    // manda al escribir (mismos nombres de campo que los parametros de buildF9pAutoProvisioning).
    // Vive aqui, junto a las claves, para que leer y escribir no puedan divergir - la UI solo hace
    // setState con lo que llega, sin conocer ni un key ID.
    fun decodeProvisioning(values: Map<Int, Long>, portTarget: String): Map<String, Any> {
        val out = LinkedHashMap<String, Any>()
        fun num(key: Int, field: String) { values[key]?.let { out[field] = it } }
        fun flag(key: Int, field: String) { values[key]?.let { out[field] = it != 0L } }

        num(0x30210001, "measRateMs")
        num(0x30210002, "navRateCyc")
        num(0x20210003, "timeRef")
        num(0x20110021, "dynModel")
        flag(0x10310024, "qzssEnabled")
        num(0x20250038, "staticHoldSpeedCmS")
        num(0x3025003b, "staticHoldExitDistanceM")

        num(0x20930001, "nmeaProtVer")
        num(0x20930002, "nmeaMaxSvs")
        flag(0x10930003, "nmeaCompat")
        flag(0x10930004, "nmeaConsider")
        flag(0x10930005, "nmeaLimit82")
        flag(0x10930006, "highPrecision")
        num(0x20930007, "nmeaSvNumbering")
        flag(0x10930011, "nmeaFiltGps")
        flag(0x10930012, "nmeaFiltSbas")
        flag(0x10930013, "nmeaFiltGal")
        flag(0x10930015, "nmeaFiltQzss")
        flag(0x10930016, "nmeaFiltGlo")
        flag(0x10930017, "nmeaFiltBds")
        flag(0x10930021, "nmeaOutInvFix")
        flag(0x10930022, "nmeaOutMskFix")
        flag(0x10930023, "nmeaOutInvTime")
        flag(0x10930024, "nmeaOutInvDate")
        flag(0x10930025, "nmeaOutOnlyGps")
        flag(0x10930026, "nmeaOutFrozenCog")
        num(0x20930031, "nmeaMainTalkerId")
        num(0x20930032, "nmeaGsvTalkerId")
        values[0x30930033]?.let { out["nmeaBdsTalkerId"] = decodeBdsTalkerId(it.toInt()) }

        val inBase = inProtBase(portTarget)
        val outBase = outProtBase(portTarget)
        flag(inBase or 0x0001, "portProtocolInUbx")
        flag(inBase or 0x0002, "portProtocolInNmea")
        flag(inBase or 0x0004, "portProtocolInRtcm3x")
        flag(inBase or 0x0005, "portProtocolInSpartn")
        flag(outBase or 0x0001, "portProtocolOutUbx")
        flag(outBase or 0x0002, "portProtocolOutNmea")
        flag(outBase or 0x0004, "portProtocolOutRtcm3x")

        when (portTarget) {
            "I2C" -> num(0x20510001, "portI2cAddress")
            "SPI" -> { flag(0x10640002, "portSpiCpol"); flag(0x10640003, "portSpiCpha") }
            "USB" -> {}
            else -> {
                val uart1 = portTarget == "UART1"
                num(if (uart1) 0x40520001 else 0x40530001, "portBaudRate")
                num(if (uart1) 0x20520002 else 0x20530002, "portStopbits")
                num(if (uart1) 0x20520003 else 0x20530003, "portDatabits")
                num(if (uart1) 0x20520004 else 0x20530004, "portParity")
            }
        }

        // msgRates: se devuelven las 21 combinaciones (7 mensajes x UART1/UART2/USB) que la UI
        // maneja, con value=0 interpretado como "apagado", igual que al escribir
        val rates = ArrayList<Map<String, Any>>()
        for ((msg, base) in NMEA_MSG_I2C_BASE_KEY) {
            for (port in listOf("UART1", "UART2", "USB")) {
                val v = values[base + nmeaPortOffset(port)] ?: continue
                rates.add(mapOf("message" to msg, "port" to port, "on" to (v != 0L), "value" to v.toInt()))
            }
        }
        if (rates.isNotEmpty()) out["msgRates"] = rates
        return out
    }

    private fun inProtBase(portTarget: String): Int = when (portTarget) {
        "I2C" -> 0x10710000
        "UART1" -> 0x10730000
        "USB" -> 0x10770000
        "SPI" -> 0x10790000
        else -> 0x10750000
    }

    private fun outProtBase(portTarget: String): Int = when (portTarget) {
        "I2C" -> 0x10720000
        "UART1" -> 0x10740000
        "USB" -> 0x10780000
        "SPI" -> 0x107a0000
        else -> 0x10760000
    }

    // inversa de encodeBdsTalkerId - 0 significa "Talker ID por defecto", sin caracteres
    private fun decodeBdsTalkerId(v: Int): String {
        if (v == 0) return ""
        val a = (v and 0xFF).toChar()
        val b = ((v shr 8) and 0xFF).toChar()
        return "$a$b"
    }
}
