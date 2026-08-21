package com.gagagps.operator

import com.gagagps.operator.rtk.RtkNtripPlugin
import com.gagagps.operator.traccar.TraccarSenderPlugin
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        registerPlugin(TraccarSenderPlugin::class.java)
        registerPlugin(RtkNtripPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
