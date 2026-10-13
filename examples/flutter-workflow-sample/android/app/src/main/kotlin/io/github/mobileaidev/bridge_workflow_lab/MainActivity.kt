package io.github.mobileaidev.bridge_workflow_lab

import android.content.Intent
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private var channel: MethodChannel? = null
    private var addressReply: MethodChannel.Result? = null
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        flutterEngine.platformViewsController.registry.registerViewFactory("workflow_lab/campaign",
            CampaignViewFactory { runOnUiThread { channel?.invokeMethod("campaignClosed", null) } })
        channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "workflow_lab/config").also { bridge ->
            bridge.setMethodCallHandler { call, reply ->
                val preferences = getSharedPreferences("workflow-lab", MODE_PRIVATE)
                when (call.method) {
                    "initialUri" -> reply.success(intent.dataString)
                    "filesDirectory" -> reply.success(filesDir.absolutePath)
                    "read" -> reply.success(preferences.getString(call.argument<String>("run"), null))
                    "write" -> {
                        val saved = preferences.edit().putString(call.argument<String>("run"), call.argument<String>("value")).commit()
                        if (saved) reply.success(null) else reply.error("persist_failed", "Draft was not saved", null)
                    }
                    "openAddress" -> {
                        addressReply = reply
                        startActivityForResult(Intent(this, AddressActivity::class.java).apply {
                            for (key in listOf("base", "run", "session")) putExtra(key, call.argument<String>(key))
                        }, 700)
                    }
                    else -> reply.notImplemented()
                }
            }
        }
    }
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 700) {
            addressReply?.success(if (resultCode == RESULT_OK) listOf("recipient", "phone", "street").associateWith { data!!.getStringExtra(it) } else null)
            addressReply = null
        }
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        channel?.invokeMethod("uriChanged", intent.dataString)
    }
}
