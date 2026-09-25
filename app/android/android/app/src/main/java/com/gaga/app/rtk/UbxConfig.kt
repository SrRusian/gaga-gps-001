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
        portProtocolOutUbx: Boolean = false,
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
    ): ByteArray {
        val clampedMeasRateMs = measRateMs.coerceIn(50, 1000) // 50ms=20Hz, techo real del F9P
        val clampedNavRateCyc = navRateCyc.coerceIn(1, 127) // 127 = maximo real del campo (u-blox)

        val protoPairs = protocolKeys(
            inBase = when (portTarget) {
                "I2C" -> 0x10710000
                "UART1" -> 0x10730000
                "USB" -> 0x10770000
                "SPI" -> 0x10790000
                else -> 0x10750000 // UART2
            },
            outBase = when (portTarget) {
                "I2C" -> 0x10720000
                "UART1" -> 0x10740000
                "USB" -> 0x10780000
                "SPI" -> 0x107a0000
                else -> 0x10760000 // UART2
            },
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

        return valSet(
            listOf(
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

                // SBAS NO se toca aqui - el protocolo moderno de claves no expone un
                // CFG-SIGNAL-SBAS_ENA en este receptor/firmware; la unica via es el mensaje legado
                // UBX-CFG-GNSS (bloques de tamano variable, requiere leer la configuracion actual
                // antes de modificarla) - se dejo fuera a proposito, ver README. Deshabilitar SBAS
                // sigue siendo manual desde u-center si se quiere ese canal libre.
                0x10310024 to bool(qzssEnabled), // CFG-SIGNAL-QZSS_ENA
            ) + protoPairs + framingPairs + msgRatePairs(msgRates),
        )
    }
}
