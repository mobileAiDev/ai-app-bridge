package io.github.mobileaidev.aiappbridge.flutter

import android.app.Activity
import android.content.Context
import android.util.Log
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject

class AiAppBridgeFlutterPlugin : FlutterPlugin, ActivityAware, MethodChannel.MethodCallHandler {
    private var channel: MethodChannel? = null
    private var activity: Activity? = null
    private var applicationContext: Context? = null
    private var bridgeActionCallback: Any? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        applicationContext = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, channelName).also {
            it.setMethodCallHandler(this)
        }
        startBridge(binding.applicationContext)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        unregisterFlutterActionBridge()
        channel?.setMethodCallHandler(null)
        channel = null
        applicationContext = null
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding.activity
        startBridge(binding.activity)
    }

    override fun onDetachedFromActivityForConfigChanges() {
        unregisterFlutterActionBridge()
        activity = null
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        onAttachedToActivity(binding)
    }

    override fun onDetachedFromActivity() {
        unregisterFlutterActionBridge()
        activity = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            if (call.method == "checkAction") {
                val bridgeClass = Class.forName(androidBridgeClassName)
                result.success(bridgeClass.getMethod("checkFlutterAction", String::class.java)
                    .invoke(null, call.arguments as String))
                return
            }
            val handled = when (call.method) {
                "updateSnapshot" -> updateSnapshot(call.arguments?.toString() ?: "{}")
                "recordLog", "recordNetwork", "recordState", "recordEvent" ->
                    recordCapture(call.method, call.arguments as String)
                else -> {
                    result.notImplemented()
                    return
                }
            }
            result.success(
                if (handled) {
                    mapOf("ok" to true)
                } else {
                    mapOf("ok" to false, "reason" to "debug_bridge_absent")
                },
            )
        } catch (error: Throwable) {
            result.error("AI_APP_BRIDGE_CALL_FAILED", error.message, null)
        }
    }

    private fun startBridge(context: Context) {
        try {
            val bridgeClass = Class.forName(androidBridgeClassName)
            val startMethod = bridgeClass.getMethod("start", Context::class.java)
            startMethod.invoke(null, context)
            // A background service also creates an engine and registers plugins.
            // Only an engine attached to an Activity owns the UI action channel.
            if (context is Activity) registerFlutterActionBridge(bridgeClass)
        } catch (_: ClassNotFoundException) {
            // The Android SDK is optional so this Flutter plugin can stay reusable.
        } catch (error: Throwable) {
            Log.w(tag, "failed to start Android AI app bridge", error)
        }
    }

    private fun registerFlutterActionBridge(bridgeClass: Class<*>) {
        if (bridgeActionCallback != null) {
            return
        }
        val currentChannel = channel ?: return
        val callbackClass = Class.forName("$androidBridgeClassName\$FlutterActionHandler")
        val callback = java.lang.reflect.Proxy.newProxyInstance(
            callbackClass.classLoader,
            arrayOf(callbackClass),
        ) { _, method, args ->
            if (method.name == "handle") {
                val values = requireNotNull(args)
                val reply = values[2]
                val replyMethod = Class.forName("$androidBridgeClassName\$FlutterActionReply").getMethod("reply", String::class.java)
                runFlutterAction(currentChannel, values[0] as String, values[1] as String) { response -> replyMethod.invoke(reply, response) }
                null
            } else {
                null
            }
        }
        bridgeClass.getMethod("setFlutterActionHandler", callbackClass).invoke(null, callback)
        bridgeActionCallback = callback
    }

    private fun unregisterFlutterActionBridge() {
        val callback = bridgeActionCallback ?: return
        try {
            val bridgeClass = Class.forName(androidBridgeClassName)
            bridgeClass.getMethod("clearFlutterActionHandler", Class.forName("$androidBridgeClassName\$FlutterActionHandler"))
                .invoke(null, callback)
        } catch (_: Throwable) {
        } finally {
            bridgeActionCallback = null
        }
    }

    private fun runFlutterAction(currentChannel: MethodChannel, method: String, payloadJson: String, reply: (String) -> Unit) {
        val posted = android.os.Handler(android.os.Looper.getMainLooper()).post {
            try { currentChannel.invokeMethod(
                method,
                payloadJson,
                object : MethodChannel.Result {
                    override fun success(result: Any?) {
                        reply(toJsonString(result))
                    }

                    override fun error(errorCode: String, errorMessage: String?, errorDetails: Any?) {
                        reply(JSONObject().put("ok", false).put("error", errorCode).put("message", errorMessage).toString())
                    }

                    override fun notImplemented() {
                        reply("""{"ok":false,"error":"flutter_action_not_implemented"}""")
                    }
                },
            ) } catch (error: Throwable) {
                reply(JSONObject().put("ok", false).put("error", "flutter_channel_failed").put("message", error.message).toString())
            }
        }
        if (!posted) reply("""{"ok":false,"error":"flutter_main_thread_unavailable"}""")
    }

    private fun toJsonString(value: Any?): String {
        return when (value) {
            null -> """{"ok":false,"error":"empty_flutter_action_result"}"""
            is String -> value
            is Map<*, *> -> JSONObject(value).toString()
            else -> JSONObject()
                .put("ok", false)
                .put("error", "invalid_flutter_action_result")
                .toString()
        }
    }

    private fun updateSnapshot(snapshotJson: String): Boolean {
        val bridgeClass = try {
            Class.forName(androidBridgeClassName)
        } catch (_: ClassNotFoundException) {
            return false
        }
        val updateMethod = bridgeClass.getMethod("updateFlutterSnapshot", String::class.java)
        updateMethod.invoke(null, snapshotJson)
        return true
    }

    private fun recordCapture(method: String, payloadJson: String): Boolean {
        return invokeAndroidBridge("recordFlutterCapture") { bridgeClass ->
            bridgeClass.getMethod("recordFlutterCapture", String::class.java, String::class.java)
                .invoke(null, method, payloadJson)
        }
    }

    private fun invokeAndroidBridge(methodName: String, call: (Class<*>) -> Unit): Boolean {
        val bridgeClass = try {
            Class.forName(androidBridgeClassName)
        } catch (_: ClassNotFoundException) {
            return false
        }
        try {
            call(bridgeClass)
            return true
        } catch (error: Throwable) {
            Log.w(tag, "failed to call Android AI app bridge method $methodName", error)
            throw error
        }
    }

    companion object {
        private const val tag = "AiAppBridge"
        private const val channelName = "ai_app_bridge"
        private const val androidBridgeClassName = "io.github.mobileaidev.aiappbridge.android.AiAppBridge"
    }
}
