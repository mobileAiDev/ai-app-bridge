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
    private var bridgeActionRegistered = false

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
        activity = null
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        onAttachedToActivity(binding)
    }

    override fun onDetachedFromActivity() {
        activity = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            val handled = when (call.method) {
                "updateSnapshot" -> updateSnapshot(call.arguments?.toString() ?: "{}")
                "recordLog" -> recordLog(call.arguments?.toString() ?: "{}")
                "recordNetwork" -> recordNetwork(call.arguments?.toString() ?: "{}")
                "recordState" -> recordState(call.arguments?.toString() ?: "{}")
                "recordEvent" -> recordEvent(call.arguments?.toString() ?: "{}")
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
            registerFlutterActionBridge(bridgeClass)
        } catch (_: ClassNotFoundException) {
            // The Android SDK is optional so this Flutter plugin can stay reusable.
        } catch (error: Throwable) {
            Log.w(tag, "failed to start Android AI app bridge", error)
        }
    }

    private fun registerFlutterActionBridge(bridgeClass: Class<*>) {
        if (bridgeActionRegistered) {
            return
        }
        val currentChannel = channel ?: return
        val callbackClass = Class.forName("$androidBridgeClassName\$FlutterActionHandler")
        val callback = java.lang.reflect.Proxy.newProxyInstance(
            callbackClass.classLoader,
            arrayOf(callbackClass),
        ) { _, method, args ->
            if (method.name == "handle") {
                val payload = args?.firstOrNull()?.toString() ?: "{}"
                runFlutterAction(currentChannel, payload)
            } else {
                null
            }
        }
        bridgeClass.getMethod("setFlutterActionHandler", callbackClass).invoke(null, callback)
        bridgeActionRegistered = true
    }

    private fun unregisterFlutterActionBridge() {
        if (!bridgeActionRegistered) {
            return
        }
        try {
            val bridgeClass = Class.forName(androidBridgeClassName)
            bridgeClass.getMethod("setFlutterActionHandler", Class.forName("$androidBridgeClassName\$FlutterActionHandler"))
                .invoke(null, null)
        } catch (_: Throwable) {
        } finally {
            bridgeActionRegistered = false
        }
    }

    private fun runFlutterAction(currentChannel: MethodChannel, payloadJson: String): String {
        val latch = java.util.concurrent.CountDownLatch(1)
        val response = java.util.concurrent.atomic.AtomicReference<String>()
        val error = java.util.concurrent.atomic.AtomicReference<String>()
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            currentChannel.invokeMethod(
                "runAction",
                payloadJson,
                object : MethodChannel.Result {
                    override fun success(result: Any?) {
                        response.set(toJsonString(result))
                        latch.countDown()
                    }

                    override fun error(errorCode: String, errorMessage: String?, errorDetails: Any?) {
                        error.set(errorMessage ?: errorCode)
                        latch.countDown()
                    }

                    override fun notImplemented() {
                        error.set("flutter_action_not_implemented")
                        latch.countDown()
                    }
                },
            )
        }
        if (!latch.await(15000L, java.util.concurrent.TimeUnit.MILLISECONDS)) {
            return """{"ok":false,"error":"flutter_action_timeout"}"""
        }
        error.get()?.let {
            return JSONObject().put("ok", false).put("error", it).toString()
        }
        return response.get() ?: """{"ok":false,"error":"empty_flutter_action_result"}"""
    }

    private fun toJsonString(value: Any?): String {
        return when (value) {
            null -> """{"ok":true}"""
            is String -> value
            is Map<*, *> -> JSONObject(value).toString()
            else -> JSONObject()
                .put("ok", true)
                .put("value", value.toString())
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

    private fun recordLog(payloadJson: String): Boolean {
        val payload = JSONObject(payloadJson)
        return invokeAndroidBridge("recordLog") { bridgeClass ->
            val method = bridgeClass.getMethod(
                "recordLog",
                String::class.java,
                String::class.java,
                String::class.java,
                String::class.java,
            )
            method.invoke(
                null,
                payload.optString("level", "info"),
                payload.optString("tag", ""),
                payload.optString("message", ""),
                payload.optJsonString("data"),
            )
        }
    }

    private fun recordNetwork(payloadJson: String): Boolean {
        val payload = JSONObject(payloadJson)
        return invokeAndroidBridge("recordNetwork") { bridgeClass ->
            val source = payload.optString("source", "flutter-sdk")
            try {
                val autoMethod = bridgeClass.getMethod(
                    "recordNetworkAuto",
                    String::class.java,
                    String::class.java,
                    String::class.java,
                    java.lang.Integer.TYPE,
                    java.lang.Long.TYPE,
                    String::class.java,
                    String::class.java,
                    String::class.java,
                    String::class.java,
                    String::class.java,
                )
                autoMethod.invoke(
                    null,
                    source,
                    payload.optString("method", "GET"),
                    payload.optString("url", ""),
                    payload.optInt("statusCode", -1),
                    payload.optLong("durationMs", -1L),
                    payload.optJsonString("requestHeaders"),
                    payload.optJsonString("responseHeaders"),
                    payload.optNullableString("requestBody"),
                    payload.optNullableString("responseBody"),
                    payload.optNullableString("error"),
                )
                return@invokeAndroidBridge
            } catch (_: NoSuchMethodException) {
                // Older Android debug SDKs only expose the compact recordNetwork API.
            }
            val method = bridgeClass.getMethod(
                "recordNetwork",
                String::class.java,
                String::class.java,
                java.lang.Integer.TYPE,
                java.lang.Long.TYPE,
                String::class.java,
                String::class.java,
                String::class.java,
            )
            method.invoke(
                null,
                payload.optString("method", "GET"),
                payload.optString("url", ""),
                payload.optInt("statusCode", -1),
                payload.optLong("durationMs", -1L),
                payload.optNullableString("requestBody"),
                payload.optNullableString("responseBody"),
                payload.optNullableString("error"),
            )
        }
    }

    private fun recordState(payloadJson: String): Boolean {
        val payload = JSONObject(payloadJson)
        return invokeAndroidBridge("recordState") { bridgeClass ->
            val method = bridgeClass.getMethod(
                "recordState",
                String::class.java,
                String::class.java,
                String::class.java,
            )
            method.invoke(
                null,
                payload.optString("namespace", "app"),
                payload.optString("key", "value"),
                payload.optJsonString("value"),
            )
        }
    }

    private fun recordEvent(payloadJson: String): Boolean {
        val payload = JSONObject(payloadJson)
        return invokeAndroidBridge("recordEvent") { bridgeClass ->
            val method = bridgeClass.getMethod(
                "recordEvent",
                String::class.java,
                String::class.java,
                String::class.java,
            )
            method.invoke(
                null,
                payload.optString("category", "app"),
                payload.optString("name", "event"),
                payload.optJsonString("data"),
            )
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

    private fun JSONObject.optNullableString(key: String): String? {
        if (!has(key) || isNull(key)) {
            return null
        }
        return optString(key)
    }

    private fun JSONObject.optJsonString(key: String): String? {
        if (!has(key) || isNull(key)) {
            return null
        }
        val value = opt(key) ?: return null
        return when (value) {
            is String -> JSONObject.quote(value)
            else -> value.toString()
        }
    }

    companion object {
        private const val tag = "AiAppBridge"
        private const val channelName = "ai_app_bridge"
        private const val androidBridgeClassName = "io.github.mobileaidev.aiappbridge.android.AiAppBridge"
    }
}

