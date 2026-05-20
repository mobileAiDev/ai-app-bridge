package io.github.mobileaidev.aiappbridge.android

import android.annotation.TargetApi
import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.MotionEvent
import android.view.PixelCopy
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.webkit.WebView
import android.widget.EditText
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.io.File
import java.lang.ref.WeakReference
import java.lang.reflect.Proxy
import java.net.BindException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.ArrayDeque
import java.util.Collections
import java.util.IdentityHashMap
import java.util.LinkedHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

object AiAppBridge {
    private const val tag = "AiAppBridge"
    private const val defaultPort = 18080
    private const val mainThreadTimeoutMs = 1500L
    private const val pixelCopyTimeoutMs = 1500L
    private const val maxLogEntries = 300
    private const val maxNetworkEntries = 200
    private const val maxEventEntries = 300
    private const val maxStateEntries = 200
    private const val maxCapturedBodyChars = 20_000
    private const val bridgeVersion = "0.2.0"
    private const val redactedValue = "[redacted]"
    private val sensitiveKeyPattern = Regex(
        "(?i)(authorization|cookie|token|accessToken|refreshToken|session|password|passwd|pwd|secret|mobile|phone|smsCode|verifyCode|verificationCode|captcha)",
    )
    @Volatile
    private var flutterActionHandler: FlutterActionHandler? = null
    private val h5DomSnapshotScript = """
        (function() {
          function text(value) {
            return value == null ? '' : String(value);
          }
          function cut(value, max) {
            var raw = text(value);
            return raw.length > max ? raw.slice(0, max) : raw;
          }
          function bounds(element) {
            var rect = element.getBoundingClientRect();
            return {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height
            };
          }
          var selector = 'a,button,input,textarea,select,[role],[onclick],[aria-label]';
          var controls = Array.prototype.slice.call(document.querySelectorAll(selector), 0, 200)
            .map(function(element, index) {
              return {
                index: index,
                tag: text(element.tagName).toLowerCase(),
                id: text(element.id),
                name: text(element.getAttribute('name')),
                type: text(element.getAttribute('type')),
                role: text(element.getAttribute('role')),
                ariaLabel: text(element.getAttribute('aria-label')),
                placeholder: text(element.getAttribute('placeholder')),
                text: cut(element.innerText || element.value || element.title || element.getAttribute('aria-label'), 300),
                href: cut(element.href, 500),
                disabled: !!element.disabled,
                bounds: bounds(element)
              };
            });
          return JSON.stringify({
            ok: true,
            title: document.title,
            url: location.href,
            readyState: document.readyState,
            bodyText: cut(document.body && document.body.innerText, 20000),
            controls: controls,
            controlCount: controls.length,
            updatedAtMs: Date.now()
          });
        })()
    """.trimIndent()

    fun interface FlutterActionHandler {
        fun handle(payloadJson: String): String
    }

    interface WebViewAdapter {
        val name: String
        fun matches(view: View): Boolean
        fun metadata(view: View): JSONObject
        fun evaluateJavascript(view: View, script: String, callback: (String?) -> Unit)
    }

    @Volatile
    private var server: DebugBridgeServer? = null

    @Volatile
    private var flutterSnapshot: String = "{}"

    @Volatile
    private var lifecycleRegistered = false

    @Volatile
    private var currentActivity: WeakReference<Activity>? = null

    private val mainHandler = Handler(Looper.getMainLooper())
    private val captureLock = Any()
    private val captureSequence = AtomicLong(0)
    private val logEntries = ArrayDeque<JSONObject>()
    private val networkEntries = ArrayDeque<JSONObject>()
    private val eventEntries = ArrayDeque<JSONObject>()
    private val stateEntries = LinkedHashMap<String, JSONObject>()
    private val webViewAdapters = CopyOnWriteArrayList<WebViewAdapter>(
        listOf(StandardAndroidWebViewAdapter, ReflectiveJavascriptWebViewAdapter),
    )

    @JvmStatic
    fun start(context: Context) {
        if (context is Activity) {
            currentActivity = WeakReference(context)
        }
        registerLifecycleCallbacks(context)
        if (server != null) {
            return
        }
        synchronized(this) {
            if (server != null) {
                return
            }
            server = DebugBridgeServer(context.applicationContext, defaultPort).also {
                it.start()
            }
        }
    }

    @JvmStatic
    fun updateFlutterSnapshot(snapshotJson: String) {
        flutterSnapshot = JSONObject(snapshotJson).toString()
    }

    @JvmStatic
    fun setFlutterActionHandler(handler: FlutterActionHandler?) {
        flutterActionHandler = handler
    }

    @JvmStatic
    fun registerWebViewAdapter(adapter: WebViewAdapter) {
        webViewAdapters.remove(adapter)
        webViewAdapters.add(0, adapter)
    }

    @JvmStatic
    fun unregisterWebViewAdapter(adapter: WebViewAdapter) {
        webViewAdapters.remove(adapter)
    }

    @JvmStatic
    fun recordLog(level: String, tag: String, message: String, dataJson: String?) {
        val payload = JSONObject()
            .put("level", level.ifBlank { "info" })
            .put("tag", tag)
            .put("message", message)
        parseOptionalJson(dataJson)?.let { payload.put("data", it) }
        recordLogPayload(payload, source = "sdk")
    }

    @JvmStatic
    fun recordNetwork(
        method: String,
        url: String,
        statusCode: Int,
        durationMs: Long,
        requestBody: String?,
        responseBody: String?,
        error: String?,
    ) {
        val payload = JSONObject()
            .put("method", method.ifBlank { "GET" })
            .put("url", url)
            .put("statusCode", statusCode)
            .put("durationMs", durationMs)
            .put("requestBody", boundedString(requestBody))
            .put("responseBody", boundedString(responseBody))
        if (!error.isNullOrBlank()) {
            payload.put("error", error)
        }
        recordNetworkPayload(payload, source = "sdk")
    }

    @JvmStatic
    fun recordNetworkAuto(
        source: String,
        method: String,
        url: String,
        statusCode: Int,
        durationMs: Long,
        requestHeadersJson: String?,
        responseHeadersJson: String?,
        requestBody: String?,
        responseBody: String?,
        error: String?,
    ) {
        val payload = JSONObject()
            .put("method", method.ifBlank { "GET" })
            .put("url", url)
            .put("statusCode", statusCode)
            .put("durationMs", durationMs)
            .put("requestBody", boundedString(requestBody))
            .put("responseBody", boundedString(responseBody))
        parseOptionalJson(requestHeadersJson)?.let { payload.put("requestHeaders", it) }
        parseOptionalJson(responseHeadersJson)?.let { payload.put("responseHeaders", it) }
        if (!error.isNullOrBlank()) {
            payload.put("error", error)
        }
        recordNetworkPayload(payload, source = source.ifBlank { "auto" })
    }

    @JvmStatic
    fun recordState(namespace: String, key: String, valueJson: String?) {
        val payload = JSONObject()
            .put("namespace", namespace.ifBlank { "app" })
            .put("key", key.ifBlank { "value" })
            .put("value", parseOptionalJson(valueJson) ?: JSONObject.NULL)
        recordStatePayload(payload, source = "sdk")
    }

    @JvmStatic
    fun recordEvent(category: String, name: String, dataJson: String?) {
        val payload = JSONObject()
            .put("category", category.ifBlank { "app" })
            .put("name", name.ifBlank { "event" })
        parseOptionalJson(dataJson)?.let { payload.put("data", it) }
        recordEventPayload(payload, source = "sdk")
    }

    private fun registerLifecycleCallbacks(context: Context) {
        if (lifecycleRegistered) {
            return
        }
        val application = context.applicationContext as? Application ?: return
        synchronized(this) {
            if (lifecycleRegistered) {
                return
            }
            application.registerActivityLifecycleCallbacks(
                object : Application.ActivityLifecycleCallbacks {
                    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
                        currentActivity = WeakReference(activity)
                    }

                    override fun onActivityStarted(activity: Activity) {
                        currentActivity = WeakReference(activity)
                    }

                    override fun onActivityResumed(activity: Activity) {
                        currentActivity = WeakReference(activity)
                    }

                    override fun onActivityPaused(activity: Activity) = Unit
                    override fun onActivityStopped(activity: Activity) = Unit
                    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

                    override fun onActivityDestroyed(activity: Activity) {
                        if (currentActivity?.get() == activity) {
                            currentActivity = null
                        }
                    }
                },
            )
            lifecycleRegistered = true
        }
    }

    private fun activity(): Activity? = currentActivity?.get()

    private fun runOnMainThread(block: () -> JSONObject): JSONObject {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return block()
        }
        val latch = CountDownLatch(1)
        val result = AtomicReference<JSONObject>()
        val error = AtomicReference<Throwable>()
        mainHandler.post {
            try {
                result.set(block())
            } catch (throwable: Throwable) {
                error.set(throwable)
            } finally {
                latch.countDown()
            }
        }
        if (!latch.await(mainThreadTimeoutMs, TimeUnit.MILLISECONDS)) {
            return JSONObject().put("ok", false).put("error", "main_thread_timeout")
        }
        error.get()?.let { throw it }
        return result.get() ?: JSONObject().put("ok", false).put("error", "empty_main_thread_result")
    }

    private fun recordLogPayload(payload: JSONObject, source: String): JSONObject {
        val event = baseCapture(type = "log", source = source)
            .put("level", payload.optString("level", "info"))
            .put("tag", payload.optString("tag", ""))
            .put("message", payload.optString("message", ""))
        if (payload.has("data")) {
            event.put("data", payload.opt("data"))
        }
        appendBounded(logEntries, event, maxLogEntries)
        return event
    }

    private fun recordNetworkPayload(payload: JSONObject, source: String): JSONObject {
        val event = baseCapture(type = "network", source = source)
            .put("method", payload.optString("method", "GET"))
            .put("url", redactUrl(payload.optString("url", "")))
            .put("statusCode", payload.optInt("statusCode", -1))
            .put("durationMs", payload.optLong("durationMs", -1L))
            .put("requestBody", redactedBoundedString(jsonStringOrNull(payload, "requestBody")))
            .put("responseBody", redactedBoundedString(jsonStringOrNull(payload, "responseBody")))
            .put("redacted", true)
        if (payload.has("requestHeaders")) {
            event.put("requestHeaders", redactJsonValue(payload.opt("requestHeaders")))
        }
        if (payload.has("responseHeaders")) {
            event.put("responseHeaders", redactJsonValue(payload.opt("responseHeaders")))
        }
        if (payload.has("error")) {
            event.put("error", payload.opt("error"))
        }
        appendBounded(networkEntries, event, maxNetworkEntries)
        return event
    }

    private fun recordStatePayload(payload: JSONObject, source: String): JSONObject {
        val namespace = payload.optString("namespace", "app").ifBlank { "app" }
        val key = payload.optString("key", "value").ifBlank { "value" }
        val event = baseCapture(type = "state", source = source)
            .put("namespace", namespace)
            .put("key", key)
            .put("value", if (payload.has("value")) payload.opt("value") else JSONObject.NULL)
        synchronized(captureLock) {
            if (!stateEntries.containsKey("$namespace.$key") && stateEntries.size >= maxStateEntries) {
                val firstKey = stateEntries.keys.firstOrNull()
                if (firstKey != null) {
                    stateEntries.remove(firstKey)
                }
            }
            stateEntries["$namespace.$key"] = event
        }
        return event
    }

    private fun recordEventPayload(payload: JSONObject, source: String): JSONObject {
        val event = baseCapture(type = "event", source = source)
            .put("category", payload.optString("category", "app"))
            .put("name", payload.optString("name", "event"))
        if (payload.has("data")) {
            event.put("data", payload.opt("data"))
        }
        appendBounded(eventEntries, event, maxEventEntries)
        return event
    }

    private fun baseCapture(type: String, source: String): JSONObject {
        return JSONObject()
            .put("id", captureSequence.incrementAndGet())
            .put("type", type)
            .put("source", source)
            .put("timestampMs", System.currentTimeMillis())
    }

    private fun appendBounded(target: ArrayDeque<JSONObject>, event: JSONObject, maxSize: Int) {
        synchronized(captureLock) {
            while (target.size >= maxSize) {
                target.removeFirst()
            }
            target.addLast(event)
        }
    }

    private fun captureCounts(): JSONObject {
        synchronized(captureLock) {
            return JSONObject()
                .put("logs", logEntries.size)
                .put("network", networkEntries.size)
                .put("state", stateEntries.size)
                .put("events", eventEntries.size)
        }
    }

    private fun buildCaptureResponse(
        type: String,
        items: JSONArray,
        filter: CaptureQuery = CaptureQuery(),
    ): JSONObject {
        return JSONObject()
            .put("ok", true)
            .put("type", type)
            .put("items", items)
            .put("count", items.length())
            .put("sinceId", filter.sinceId ?: JSONObject.NULL)
            .put("sinceMs", filter.sinceMs ?: JSONObject.NULL)
            .put("limit", filter.limit)
            .put("updatedAtMs", System.currentTimeMillis())
    }

    private fun buildLogs(query: Map<String, String> = emptyMap()): JSONObject {
        val filter = CaptureQuery.from(query)
        synchronized(captureLock) {
            return buildCaptureResponse("logs", copyArray(logEntries, filter), filter)
        }
    }

    private fun buildNetwork(query: Map<String, String> = emptyMap()): JSONObject {
        val filter = CaptureQuery.from(query)
        synchronized(captureLock) {
            return buildCaptureResponse("network", copyArray(networkEntries, filter), filter)
        }
    }

    private fun buildEvents(query: Map<String, String> = emptyMap()): JSONObject {
        val filter = CaptureQuery.from(query)
        synchronized(captureLock) {
            return buildCaptureResponse("events", copyArray(eventEntries, filter), filter)
        }
    }

    private fun buildState(query: Map<String, String> = emptyMap()): JSONObject {
        val filter = CaptureQuery.from(query)
        synchronized(captureLock) {
            val values = JSONObject()
            val items = JSONArray()
            val filtered = stateEntries.entries.filter { (_, entry) -> filter.matches(entry) }
            val limited = if (filtered.size > filter.limit) {
                filtered.takeLast(filter.limit)
            } else {
                filtered
            }
            limited.forEach { (stateKey, entry) ->
                if (!filter.matches(entry)) {
                    return@forEach
                }
                val copy = JSONObject(entry.toString())
                values.put(stateKey, copy.opt("value"))
                items.put(copy)
            }
            return JSONObject()
                .put("ok", true)
                .put("type", "state")
                .put("values", values)
                .put("items", items)
                .put("count", items.length())
                .put("sinceId", filter.sinceId ?: JSONObject.NULL)
                .put("sinceMs", filter.sinceMs ?: JSONObject.NULL)
                .put("limit", filter.limit)
                .put("updatedAtMs", System.currentTimeMillis())
        }
    }

    private fun copyArray(values: ArrayDeque<JSONObject>, filter: CaptureQuery = CaptureQuery()): JSONArray {
        val array = JSONArray()
        val filtered = values.filter { filter.matches(it) }
        val limited = if (filtered.size > filter.limit) {
            filtered.takeLast(filter.limit)
        } else {
            filtered
        }
        limited.forEach { value ->
            array.put(JSONObject(value.toString()))
        }
        return array
    }

    private fun requestJson(body: String): JSONObject {
        return JSONObject(body.ifBlank { "{}" })
    }

    private fun parseQuery(rawQuery: String): Map<String, String> {
        if (rawQuery.isBlank()) {
            return emptyMap()
        }
        return rawQuery
            .split("&")
            .filter { it.isNotBlank() }
            .associate { part ->
                val key = part.substringBefore("=")
                val value = part.substringAfter("=", "")
                decodeUrl(key) to decodeUrl(value)
            }
    }

    private fun decodeUrl(value: String): String {
        return URLDecoder.decode(value, StandardCharsets.UTF_8.name())
    }

    private fun postLog(body: String): JSONObject {
        val event = recordLogPayload(requestJson(body), source = "http")
        return JSONObject().put("ok", true).put("event", event)
    }

    private fun postNetwork(body: String): JSONObject {
        val event = recordNetworkPayload(requestJson(body), source = "http")
        return JSONObject().put("ok", true).put("event", event)
    }

    private fun postState(body: String): JSONObject {
        val event = recordStatePayload(requestJson(body), source = "http")
        return JSONObject().put("ok", true).put("event", event)
    }

    private fun postEvent(body: String): JSONObject {
        val event = recordEventPayload(requestJson(body), source = "http")
        return JSONObject().put("ok", true).put("event", event)
    }

    private fun parseOptionalJson(raw: String?): Any? {
        val trimmed = raw?.trim() ?: return null
        if (trimmed.isEmpty()) {
            return null
        }
        return try {
            JSONTokener(trimmed).nextValue()
        } catch (_: Throwable) {
            raw
        }
    }

    private fun boundedString(value: String?): Any {
        if (value == null) {
            return JSONObject.NULL
        }
        return if (value.length > maxCapturedBodyChars) {
            value.take(maxCapturedBodyChars)
        } else {
            value
        }
    }

    private fun redactedBoundedString(value: String?): Any {
        val bounded = boundedString(value)
        if (bounded == JSONObject.NULL) {
            return bounded
        }
        return redactPayloadString(bounded.toString())
    }

    private fun redactPayloadString(raw: String): String {
        val parsed = parseOptionalJson(raw)
        return when (parsed) {
            is JSONObject -> redactJsonObject(parsed).toString()
            is JSONArray -> redactJsonArray(parsed).toString()
            is String -> redactFormPayload(raw)
            else -> raw
        }
    }

    private fun redactUrl(raw: String): String {
        if (raw.isBlank() || !raw.contains("?")) {
            return raw
        }
        return try {
            val uri = Uri.parse(raw)
            val parameterNames = uri.queryParameterNames
            if (parameterNames.isEmpty()) {
                return raw
            }
            val builder = uri.buildUpon().clearQuery()
            parameterNames.forEach { name ->
                val values = uri.getQueryParameters(name)
                if (values.isEmpty()) {
                    builder.appendQueryParameter(name, if (isSensitiveKey(name)) redactedValue else "")
                } else {
                    values.forEach { value ->
                        builder.appendQueryParameter(name, if (isSensitiveKey(name)) redactedValue else value)
                    }
                }
            }
            builder.build().toString()
        } catch (_: Throwable) {
            raw
        }
    }

    private fun redactFormPayload(raw: String): String {
        if (!raw.contains("=")) {
            return raw
        }
        return raw.split("&").joinToString("&") { part ->
            val key = part.substringBefore("=")
            val value = part.substringAfter("=", "")
            if (isSensitiveKey(key)) {
                "$key=$redactedValue"
            } else {
                "$key=$value"
            }
        }
    }

    private fun redactJsonValue(value: Any?): Any {
        return when (value) {
            null -> JSONObject.NULL
            JSONObject.NULL -> JSONObject.NULL
            is JSONObject -> redactJsonObject(value)
            is JSONArray -> redactJsonArray(value)
            else -> value
        }
    }

    private fun redactJsonObject(source: JSONObject): JSONObject {
        val target = JSONObject()
        val keys = source.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = if (isSensitiveKey(key)) redactedValue else redactJsonValue(source.opt(key))
            target.put(key, value)
        }
        return target
    }

    private fun redactJsonArray(source: JSONArray): JSONArray {
        val target = JSONArray()
        for (index in 0 until source.length()) {
            target.put(redactJsonValue(source.opt(index)))
        }
        return target
    }

    private fun isSensitiveKey(key: String): Boolean {
        return sensitiveKeyPattern.containsMatchIn(key)
    }

    private fun jsonStringOrNull(json: JSONObject, key: String): String? {
        if (!json.has(key) || json.isNull(key)) {
            return null
        }
        return json.optString(key)
    }

    private data class CaptureQuery(
        val sinceId: Long? = null,
        val sinceMs: Long? = null,
        val limit: Int = defaultLimit,
    ) {
        fun matches(item: JSONObject): Boolean {
            val id = item.optLong("id", Long.MIN_VALUE)
            val timestampMs = item.optLong("timestampMs", Long.MIN_VALUE)
            if (sinceId != null && id <= sinceId) {
                return false
            }
            if (sinceMs != null && timestampMs < sinceMs) {
                return false
            }
            return true
        }

        companion object {
            private const val defaultLimit = 200
            private const val maxLimit = 500

            fun from(query: Map<String, String>): CaptureQuery {
                val limit = query["limit"]
                    ?.toIntOrNull()
                    ?.coerceIn(1, maxLimit)
                    ?: defaultLimit
                return CaptureQuery(
                    sinceId = query["sinceId"]?.toLongOrNull(),
                    sinceMs = query["sinceMs"]?.toLongOrNull(),
                    limit = limit,
                )
            }
        }
    }

    private data class WebViewTarget(
        val view: View,
        val adapter: WebViewAdapter,
    )

    private object StandardAndroidWebViewAdapter : WebViewAdapter {
        override val name: String = "android-webview"

        override fun matches(view: View): Boolean = view is WebView

        override fun metadata(view: View): JSONObject {
            val webView = view as WebView
            return JSONObject()
                .put("adapter", name)
                .put("className", webView.javaClass.name)
                .put("url", webView.url ?: "")
                .put("title", webView.title ?: "")
                .put("progress", webView.progress)
        }

        override fun evaluateJavascript(view: View, script: String, callback: (String?) -> Unit) {
            (view as WebView).evaluateJavascript(script) { raw -> callback(raw) }
        }
    }

    private object ReflectiveJavascriptWebViewAdapter : WebViewAdapter {
        override val name: String = "reflective-webview"

        override fun matches(view: View): Boolean {
            if (view is WebView) {
                return false
            }
            val className = view.javaClass.name.lowercase()
            if (
                !className.contains("webview") &&
                !className.contains("smtt") &&
                !className.contains("x5") &&
                !className.contains("xwalk") &&
                !className.contains("crosswalk") &&
                !className.contains("ucweb") &&
                !className.contains("nebulauc")
            ) {
                return false
            }
            return evaluateMethod(view) != null
        }

        override fun metadata(view: View): JSONObject {
            return JSONObject()
                .put("adapter", name)
                .put("className", view.javaClass.name)
                .put("url", invokeNoArg(view, "getUrl") ?: "")
                .put("title", invokeNoArg(view, "getTitle") ?: "")
                .put("progress", invokeNoArg(view, "getProgress") ?: JSONObject.NULL)
        }

        override fun evaluateJavascript(view: View, script: String, callback: (String?) -> Unit) {
            val method = evaluateMethod(view)
                ?: throw IllegalStateException("evaluateJavascript_not_found:${view.javaClass.name}")
            val callbackType = method.parameterTypes[1]
            val proxy = Proxy.newProxyInstance(
                callbackType.classLoader,
                arrayOf(callbackType),
            ) { instance, invokedMethod, args ->
                when (invokedMethod.name) {
                    "onReceiveValue" -> {
                        callback(args?.firstOrNull()?.toString())
                        null
                    }
                    "toString" -> "AiAppBridgeWebViewCallback"
                    "hashCode" -> System.identityHashCode(instance)
                    "equals" -> instance === args?.firstOrNull()
                    else -> null
                }
            }
            method.invoke(view, script, proxy)
        }

        private fun evaluateMethod(view: View) = view.javaClass.methods.firstOrNull { method ->
            method.name == "evaluateJavascript" &&
                method.parameterTypes.size == 2 &&
                method.parameterTypes[0] == String::class.java &&
                method.parameterTypes[1].isInterface
        }

        private fun invokeNoArg(view: View, methodName: String): Any? {
            return try {
                view.javaClass.methods.firstOrNull {
                    it.name == methodName && it.parameterTypes.isEmpty()
                }?.invoke(view)
            } catch (_: Throwable) {
                null
            }
        }
    }

    private class DebugBridgeServer(
        private val context: Context,
        private val port: Int,
    ) {
        private val activePort = AtomicInteger(port)
        private val executor = Executors.newSingleThreadExecutor { task ->
            Thread(task, "ai-app-bridge").apply { isDaemon = true }
        }

        fun start() {
            executor.execute {
                writePortState(ok = false, port = port, error = "starting")
                var lastError: Throwable? = null
                for (candidatePort in port..(port + 50)) {
                    try {
                        serve(candidatePort)
                        return@execute
                    } catch (error: BindException) {
                        lastError = error
                        Log.w(tag, "AI app bridge port $candidatePort is already in use", error)
                    } catch (error: SecurityException) {
                        lastError = error
                        Log.w(tag, "AI app bridge cannot open local socket; INTERNET permission is required", error)
                        break
                    } catch (error: Throwable) {
                        lastError = error
                        Log.w(tag, "AI app bridge stopped", error)
                        break
                    }
                }
                writePortState(
                    ok = false,
                    port = port,
                    error = lastError?.javaClass?.simpleName ?: "no_available_port",
                )
            }
        }

        private fun serve(candidatePort: Int) {
            ServerSocket().use { serverSocket ->
                serverSocket.reuseAddress = true
                serverSocket.bind(
                    InetSocketAddress(InetAddress.getByName("127.0.0.1"), candidatePort),
                )
                activePort.set(candidatePort)
                writePortState(ok = true, port = candidatePort, error = null)
                Log.i(tag, "AI app bridge listening on 127.0.0.1:$candidatePort")
                while (!Thread.currentThread().isInterrupted) {
                    handleClient(serverSocket.accept())
                }
            }
        }

        private fun writePortState(ok: Boolean, port: Int, error: String?) {
            try {
                val payload = JSONObject()
                    .put("ok", ok)
                    .put("packageName", context.packageName)
                    .put("port", port)
                    .put("version", bridgeVersion)
                    .put("updatedAtMs", System.currentTimeMillis())
                if (!error.isNullOrBlank()) {
                    payload.put("error", error)
                }
                File(context.filesDir, "ai_app_bridge_port.json").writeText(payload.toString())
            } catch (error: Throwable) {
                Log.w(tag, "AI app bridge failed to write port state", error)
            }
        }

        private fun handleClient(socket: Socket) {
            socket.use {
                try {
                    val request = readRequest(socket)
                    when {
                        request.method == "GET" && request.path == "/v1/status" -> {
                            writeJson(socket, 200, buildStatus())
                        }
                        request.method == "GET" && request.path == "/v1/view/tree" -> {
                            writeJson(socket, 200, buildViewTree())
                        }
                        request.method == "GET" && request.path == "/v1/screenshot" -> {
                            writeJson(socket, 200, buildScreenshot())
                        }
                        request.method == "GET" && request.path == "/v1/logs" -> {
                            writeJson(socket, 200, buildLogs(request.query))
                        }
                        request.method == "GET" && request.path == "/v1/network" -> {
                            writeJson(socket, 200, buildNetwork(request.query))
                        }
                        request.method == "GET" && request.path == "/v1/state" -> {
                            writeJson(socket, 200, buildState(request.query))
                        }
                        request.method == "GET" && request.path == "/v1/events" -> {
                            writeJson(socket, 200, buildEvents(request.query))
                        }
                        request.method == "GET" && request.path == "/v1/h5/dom" -> {
                            writeJson(socket, 200, buildH5Dom())
                        }
                        request.method == "POST" && request.path == "/v1/action/tap" -> {
                            writeJson(socket, 200, dispatchTap(request.body))
                        }
                        request.method == "POST" && request.path == "/v1/action/input-text" -> {
                            writeJson(socket, 200, dispatchInputText(request.body))
                        }
                        request.method == "POST" && request.path == "/v1/flutter/action" -> {
                            writeJson(socket, 200, dispatchFlutterAction(request.body))
                        }
                        request.method == "POST" && request.path == "/v1/h5/eval" -> {
                            writeJson(socket, 200, executeH5Script(request.body))
                        }
                        request.method == "POST" && request.path == "/v1/flutter/snapshot" -> {
                            updateFlutterSnapshot(request.body)
                            writeJson(socket, 200, JSONObject().put("ok", true))
                        }
                        request.method == "POST" && request.path == "/v1/logs" -> {
                            writeJson(socket, 200, postLog(request.body))
                        }
                        request.method == "POST" && request.path == "/v1/network" -> {
                            writeJson(socket, 200, postNetwork(request.body))
                        }
                        request.method == "POST" && request.path == "/v1/state" -> {
                            writeJson(socket, 200, postState(request.body))
                        }
                        request.method == "POST" && request.path == "/v1/events" -> {
                            writeJson(socket, 200, postEvent(request.body))
                        }
                        else -> {
                            writeJson(
                                socket,
                                404,
                                JSONObject().put("ok", false).put("error", "not_found"),
                            )
                        }
                    }
                } catch (error: Throwable) {
                    writeJson(
                        socket,
                        500,
                        JSONObject().put("ok", false).put("error", error.toString()),
                    )
                }
            }
        }

        private fun readRequest(socket: Socket): HttpRequest {
            val input = socket.getInputStream()
            val headerBytes = ByteArrayOutputStream()
            val tail = IntArray(4)
            var tailSize = 0
            while (true) {
                val next = input.read()
                if (next == -1) {
                    break
                }
                headerBytes.write(next)
                tail[tailSize % tail.size] = next
                tailSize++
                if (tailSize >= 4 && isHeaderEnd(tail, tailSize)) {
                    break
                }
            }

            val headerText = headerBytes.toString(StandardCharsets.UTF_8.name())
            val lines = headerText.split("\r\n")
            val firstLine = lines.firstOrNull().orEmpty().split(" ")
            val method = firstLine.getOrNull(0).orEmpty()
            val target = firstLine.getOrNull(1).orEmpty()
            val path = target.substringBefore("?")
            val query = parseQuery(target.substringAfter("?", ""))
            val contentLength = lines.firstOrNull {
                it.startsWith("content-length:", ignoreCase = true)
            }?.substringAfter(":")?.trim()?.toIntOrNull() ?: 0
            val bodyBytes = ByteArray(contentLength)
            var offset = 0
            while (offset < contentLength) {
                val read = input.read(bodyBytes, offset, contentLength - offset)
                if (read <= 0) {
                    break
                }
                offset += read
            }
            return HttpRequest(
                method = method,
                path = path,
                query = query,
                body = String(bodyBytes, 0, offset, StandardCharsets.UTF_8),
            )
        }

        private fun isHeaderEnd(tail: IntArray, tailSize: Int): Boolean {
            val start = tailSize % tail.size
            return tail[start] == '\r'.code &&
                tail[(start + 1) % tail.size] == '\n'.code &&
                tail[(start + 2) % tail.size] == '\r'.code &&
                tail[(start + 3) % tail.size] == '\n'.code
        }

        private fun buildStatus(): JSONObject {
            val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            val debuggable =
                context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
            return JSONObject()
                .put("ok", true)
                .put(
                    "debugBridge",
                    JSONObject()
                        .put("name", "ai_app_bridge")
                        .put("version", bridgeVersion)
                        .put("transport", "http")
                        .put("host", "127.0.0.1")
                        .put("port", activePort.get()),
                )
                .put(
                    "app",
                    JSONObject()
                        .put("packageName", context.packageName)
                        .put("versionName", packageInfo.versionName ?: "")
                        .put("versionCode", versionCode(packageInfo))
                        .put("debuggable", debuggable),
                )
                .put(
                    "android",
                    JSONObject()
                        .put("manufacturer", Build.MANUFACTURER)
                        .put("model", Build.MODEL)
                        .put("sdkInt", Build.VERSION.SDK_INT),
                )
                .put(
                    "activity",
                    JSONObject()
                        .put("current", activity()?.javaClass?.name ?: JSONObject.NULL),
                )
                .put("capture", captureCounts())
                .put("flutter", JSONObject(AiAppBridge.flutterSnapshot))
                .put("updatedAtMs", System.currentTimeMillis())
        }

        private fun buildViewTree(): JSONObject {
            return runOnMainThread {
                val activity = activity()
                    ?: return@runOnMainThread JSONObject()
                        .put("ok", false)
                        .put("error", "no_current_activity")
                val root = activity.window?.decorView
                    ?: return@runOnMainThread JSONObject()
                        .put("ok", false)
                        .put("error", "no_decor_view")
                val counter = NodeCounter()
                val roots = windowRoots(activity)
                val windows = JSONArray()
                roots.forEachIndexed { index, windowRoot ->
                    windows.put(
                        JSONObject()
                            .put("index", index)
                            .put("type", windowRoot.type)
                            .put("rootClassName", windowRoot.root.javaClass.name)
                            .put("activityDecor", windowRoot.activityDecor)
                            .put("bounds", rectToJson(windowRoot.bounds))
                            .put("root", viewToJson(activity, windowRoot.root, counter, depth = 0, parentEffectiveVisible = true)),
                    )
                }
                JSONObject()
                    .put("ok", true)
                    .put("activity", activity.javaClass.name)
                    .put("root", viewToJson(activity, root, counter, depth = 0, parentEffectiveVisible = true))
                    .put("windows", windows)
                    .put("windowCount", roots.size)
                    .put("nodeCount", counter.count)
                    .put("updatedAtMs", System.currentTimeMillis())
            }
        }

        private fun buildH5Dom(): JSONObject {
            val latch = CountDownLatch(1)
            val result = AtomicReference<JSONObject>()
            mainHandler.post {
                try {
                    val activity = activity()
                    if (activity == null) {
                        result.set(JSONObject().put("ok", false).put("error", "no_current_activity"))
                        latch.countDown()
                        return@post
                    }
                    val root = activity.window?.decorView
                    if (root == null) {
                        result.set(JSONObject().put("ok", false).put("error", "no_decor_view"))
                        latch.countDown()
                        return@post
                    }
                    val target = findWebViewTarget(root)
                    if (target == null) {
                        result.set(
                            JSONObject()
                                .put("ok", false)
                                .put("error", "no_webview")
                                .put("activity", activity.javaClass.name),
                        )
                        latch.countDown()
                        return@post
                    }
                    target.adapter.evaluateJavascript(target.view, h5DomSnapshotScript) { raw ->
                        try {
                            result.set(
                                JSONObject()
                                    .put("ok", true)
                                    .put("activity", activity.javaClass.name)
                                    .put("webView", target.adapter.metadata(target.view))
                                    .put("dom", decodeJavascriptObject(raw))
                                    .put("updatedAtMs", System.currentTimeMillis()),
                            )
                        } catch (error: Throwable) {
                            result.set(
                                JSONObject()
                                    .put("ok", false)
                                    .put("error", error.toString())
                                    .put("raw", raw ?: JSONObject.NULL),
                            )
                        } finally {
                            latch.countDown()
                        }
                    }
                } catch (error: Throwable) {
                    result.set(JSONObject().put("ok", false).put("error", error.toString()))
                    latch.countDown()
                }
            }
            if (!latch.await(mainThreadTimeoutMs, TimeUnit.MILLISECONDS)) {
                return JSONObject()
                    .put("ok", false)
                    .put("error", "h5_dom_timeout")
            }
            return result.get() ?: JSONObject()
                .put("ok", false)
                .put("error", "empty_h5_dom_result")
        }

        private fun executeH5Script(body: String): JSONObject {
            val json = requestJson(body)
            val script = json.optString("script").trim()
            if (script.isEmpty()) {
                return JSONObject()
                    .put("ok", false)
                    .put("error", "missing_script")
            }

            val latch = CountDownLatch(1)
            val result = AtomicReference<JSONObject>()
            mainHandler.post {
                try {
                    val activity = activity()
                    if (activity == null) {
                        result.set(JSONObject().put("ok", false).put("error", "no_current_activity"))
                        latch.countDown()
                        return@post
                    }
                    val root = activity.window?.decorView
                    if (root == null) {
                        result.set(JSONObject().put("ok", false).put("error", "no_decor_view"))
                        latch.countDown()
                        return@post
                    }
                    val target = findWebViewTarget(root)
                    if (target == null) {
                        result.set(
                            JSONObject()
                                .put("ok", false)
                                .put("error", "no_webview")
                                .put("activity", activity.javaClass.name),
                        )
                        latch.countDown()
                        return@post
                    }
                    target.adapter.evaluateJavascript(target.view, script) { raw ->
                        result.set(
                            JSONObject()
                                .put("ok", true)
                                .put("activity", activity.javaClass.name)
                                .put("webView", target.adapter.metadata(target.view))
                                .put("result", decodeJavascriptValue(raw))
                                .put("raw", raw ?: JSONObject.NULL)
                                .put("updatedAtMs", System.currentTimeMillis()),
                        )
                        latch.countDown()
                    }
                } catch (error: Throwable) {
                    result.set(JSONObject().put("ok", false).put("error", error.toString()))
                    latch.countDown()
                }
            }
            if (!latch.await(mainThreadTimeoutMs, TimeUnit.MILLISECONDS)) {
                return JSONObject()
                    .put("ok", false)
                    .put("error", "h5_eval_timeout")
            }
            return result.get() ?: JSONObject()
                .put("ok", false)
                .put("error", "empty_h5_eval_result")
        }

        private fun buildScreenshot(): JSONObject {
            val target = AtomicReference<ScreenshotTarget>()
            val targetStatus = runOnMainThread {
                val activity = activity()
                    ?: return@runOnMainThread JSONObject()
                        .put("ok", false)
                        .put("error", "no_current_activity")
                val root = activity.window?.decorView
                    ?: return@runOnMainThread JSONObject()
                        .put("ok", false)
                        .put("error", "no_decor_view")
                if (root.width <= 0 || root.height <= 0) {
                    return@runOnMainThread JSONObject()
                        .put("ok", false)
                        .put("error", "invalid_root_size")
                        .put("width", root.width)
                        .put("height", root.height)
                }
                val rootLocation = IntArray(2)
                root.getLocationOnScreen(rootLocation)
                val surfaceView = findSurfaceView(root)
                val surfaceLocation = IntArray(2)
                surfaceView?.getLocationOnScreen(surfaceLocation)
                target.set(
                    ScreenshotTarget(
                        window = activity.window,
                        root = root,
                        surfaceView = surfaceView,
                        surfaceLeft = surfaceLocation[0] - rootLocation[0],
                        surfaceTop = surfaceLocation[1] - rootLocation[1],
                        width = root.width,
                        height = root.height,
                    ),
                )
                JSONObject().put("ok", true)
            }
            if (!targetStatus.optBoolean("ok")) {
                return targetStatus
            }
            val screenshotTarget = target.get()
                ?: return JSONObject()
                    .put("ok", false)
                    .put("error", "empty_screenshot_target")
            val bitmap = Bitmap.createBitmap(
                screenshotTarget.width,
                screenshotTarget.height,
                Bitmap.Config.ARGB_8888,
            )
            val captureStatus = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val pixelCopyResult = if (screenshotTarget.surfaceView != null) {
                    pixelCopySurface(screenshotTarget, bitmap)
                } else {
                    pixelCopyWindow(screenshotTarget.window, bitmap)
                }
                // Fallback to View.draw() if PixelCopy fails (e.g. DRM-protected surfaces,
                // certain device manufacturers returning ERROR_SOURCE_NO_DATA).
                if (!pixelCopyResult.optBoolean("ok")) {
                    drawRootToBitmap(screenshotTarget.root, bitmap)
                } else {
                    pixelCopyResult
                }
            } else {
                drawRootToBitmap(screenshotTarget.root, bitmap)
            }
            if (!captureStatus.optBoolean("ok")) {
                bitmap.recycle()
                return captureStatus
            }
            return bitmapToJson(bitmap, screenshotTarget.width, screenshotTarget.height)
        }

        private fun pixelCopySurface(target: ScreenshotTarget, bitmap: Bitmap): JSONObject {
            val surfaceView = target.surfaceView
                ?: return JSONObject()
                    .put("ok", false)
                    .put("error", "no_surface_view")
            if (
                surfaceView.width == target.width &&
                surfaceView.height == target.height &&
                target.surfaceLeft == 0 &&
                target.surfaceTop == 0
            ) {
                return pixelCopySurfaceToBitmap(surfaceView, bitmap)
            }
            val surfaceBitmap = Bitmap.createBitmap(
                surfaceView.width,
                surfaceView.height,
                Bitmap.Config.ARGB_8888,
            )
            val surfaceStatus = pixelCopySurfaceToBitmap(surfaceView, surfaceBitmap)
            if (!surfaceStatus.optBoolean("ok")) {
                surfaceBitmap.recycle()
                return surfaceStatus
            }
            Canvas(bitmap).drawBitmap(
                surfaceBitmap,
                target.surfaceLeft.toFloat(),
                target.surfaceTop.toFloat(),
                null,
            )
            surfaceBitmap.recycle()
            return JSONObject().put("ok", true)
        }

        @TargetApi(Build.VERSION_CODES.O)
        private fun pixelCopySurfaceToBitmap(surfaceView: SurfaceView, bitmap: Bitmap): JSONObject {
            val latch = CountDownLatch(1)
            val result = AtomicReference<Int>()
            val handlerThread = HandlerThread("ai-app-bridge-surfacecopy").also {
                it.start()
            }
            return try {
                PixelCopy.request(
                    surfaceView,
                    bitmap,
                    { copyResult ->
                        result.set(copyResult)
                        latch.countDown()
                    },
                    Handler(handlerThread.looper),
                )
                if (!latch.await(pixelCopyTimeoutMs, TimeUnit.MILLISECONDS)) {
                    return JSONObject()
                        .put("ok", false)
                        .put("error", "surface_copy_timeout")
                }
                val copyResult = result.get()
                if (copyResult != PixelCopy.SUCCESS) {
                    return JSONObject()
                        .put("ok", false)
                        .put("error", "surface_copy_failed")
                        .put("result", copyResult)
                }
                JSONObject().put("ok", true)
            } catch (throwable: Throwable) {
                JSONObject()
                    .put("ok", false)
                    .put("error", throwable.toString())
            } finally {
                handlerThread.quitSafely()
            }
        }

        @TargetApi(Build.VERSION_CODES.O)
        private fun pixelCopyWindow(window: Window, bitmap: Bitmap): JSONObject {
            val latch = CountDownLatch(1)
            val result = AtomicReference<Int>()
            val handlerThread = HandlerThread("ai-app-bridge-pixelcopy").also {
                it.start()
            }
            return try {
                PixelCopy.request(
                    window,
                    bitmap,
                    { copyResult ->
                        result.set(copyResult)
                        latch.countDown()
                    },
                    Handler(handlerThread.looper),
                )
                if (!latch.await(pixelCopyTimeoutMs, TimeUnit.MILLISECONDS)) {
                    return JSONObject()
                        .put("ok", false)
                        .put("error", "pixel_copy_timeout")
                }
                val copyResult = result.get()
                if (copyResult != PixelCopy.SUCCESS) {
                    return JSONObject()
                        .put("ok", false)
                        .put("error", "pixel_copy_failed")
                        .put("result", copyResult)
                }
                JSONObject().put("ok", true)
            } catch (throwable: Throwable) {
                JSONObject()
                    .put("ok", false)
                    .put("error", throwable.toString())
            } finally {
                handlerThread.quitSafely()
            }
        }

        private fun drawRootToBitmap(root: View, bitmap: Bitmap): JSONObject {
            return runOnMainThread {
                val canvas = Canvas(bitmap)
                root.draw(canvas)
                JSONObject().put("ok", true)
            }
        }

        private fun bitmapToJson(bitmap: Bitmap, width: Int, height: Int): JSONObject {
            return try {
                val output = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
                JSONObject()
                    .put("ok", true)
                    .put("mimeType", "image/png")
                    .put("width", width)
                    .put("height", height)
                    .put("base64", Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP))
                    .put("updatedAtMs", System.currentTimeMillis())
            } finally {
                bitmap.recycle()
            }
        }

        private fun dispatchTap(body: String): JSONObject {
            val request = JSONObject(body.ifBlank { "{}" })
            val x = request.optDouble("x", Double.NaN).toFloat()
            val y = request.optDouble("y", Double.NaN).toFloat()
            if (x.isNaN() || y.isNaN()) {
                return JSONObject()
                    .put("ok", false)
                    .put("error", "x_y_required")
            }
            return runOnMainThread {
                val activity = activity()
                    ?: return@runOnMainThread JSONObject()
                        .put("ok", false)
                        .put("error", "no_current_activity")
                val fallbackRoot = activity.window?.decorView
                    ?: return@runOnMainThread JSONObject()
                        .put("ok", false)
                        .put("error", "no_decor_view")
                val roots = windowRoots(activity)
                val target = roots.asReversed().firstOrNull {
                    it.bounds.contains(x.toInt(), y.toInt()) && it.root.isShown
                } ?: WindowRoot(
                    root = fallbackRoot,
                    bounds = boundsForView(fallbackRoot),
                    type = "activity",
                    activityDecor = true,
                )
                val localX = x - target.bounds.left
                val localY = y - target.bounds.top
                val downTime = SystemClock.uptimeMillis()
                val eventTime = downTime + 48L
                val down = MotionEvent.obtain(
                    downTime,
                    downTime,
                    MotionEvent.ACTION_DOWN,
                    localX,
                    localY,
                    0,
                )
                val up = MotionEvent.obtain(
                    downTime,
                    eventTime,
                    MotionEvent.ACTION_UP,
                    localX,
                    localY,
                    0,
                )
                val handledDown = target.root.dispatchTouchEvent(down)
                val handledUp = target.root.dispatchTouchEvent(up)
                down.recycle()
                up.recycle()
                JSONObject()
                    .put("ok", true)
                    .put("x", x.toDouble())
                    .put("y", y.toDouble())
                    .put("localX", localX.toDouble())
                    .put("localY", localY.toDouble())
                    .put("windowType", target.type)
                    .put("rootClassName", target.root.javaClass.name)
                    .put("rootBounds", rectToJson(target.bounds))
                    .put("handledDown", handledDown)
                    .put("handledUp", handledUp)
                    .put("updatedAtMs", System.currentTimeMillis())
            }
        }

        private fun dispatchInputText(body: String): JSONObject {
            val request = requestJson(body)
            val rawText = request.opt("text")
            if (!request.has("text") || rawText == null || rawText == JSONObject.NULL) {
                return JSONObject()
                    .put("ok", false)
                    .put("error", "text_required")
            }
            val text = rawText.toString()
            val x = request.optDouble("x", Double.NaN).toFloat()
            val y = request.optDouble("y", Double.NaN).toFloat()
            return runOnMainThread {
                val activity = activity()
                    ?: return@runOnMainThread JSONObject()
                        .put("ok", false)
                        .put("error", "no_current_activity")
                val roots = windowRoots(activity)
                val target = findInputTextTarget(roots, x, y)
                    ?: return@runOnMainThread JSONObject()
                        .put("ok", false)
                        .put("error", "input_target_not_found")
                        .put("message", "No enabled visible EditText was focused or matched by the requested coordinates.")

                val requestedFocus = target.view.requestFocus()
                target.view.setText(text)
                target.view.setSelection(target.view.text?.length ?: 0)
                JSONObject()
                    .put("ok", true)
                    .put("transport", "bridge")
                    .put("source", "native-view")
                    .put("text", text)
                    .put("textLength", text.length)
                    .put("requestedFocus", requestedFocus)
                    .put("focused", target.view.isFocused)
                    .put("windowType", target.root.type)
                    .put("target", editTextToJson(activity, target.view))
                    .put("updatedAtMs", System.currentTimeMillis())
            }
        }

        private fun dispatchFlutterAction(body: String): JSONObject {
            val handler = flutterActionHandler
                ?: return JSONObject()
                    .put("ok", false)
                    .put("error", "flutter_action_handler_absent")
            return try {
                JSONObject(handler.handle(body.ifBlank { "{}" }))
            } catch (error: Throwable) {
                JSONObject()
                    .put("ok", false)
                    .put("error", error.toString())
            }
        }

        private fun viewToJson(
            activity: Activity,
            view: View,
            counter: NodeCounter,
            depth: Int,
            parentEffectiveVisible: Boolean,
        ): JSONObject {
            counter.count += 1
            val location = IntArray(2)
            view.getLocationOnScreen(location)
            val localVisible = view.visibility == View.VISIBLE
            val effectiveVisible = parentEffectiveVisible &&
                localVisible &&
                view.alpha > 0f &&
                view.width > 0 &&
                view.height > 0
            val json = JSONObject()
                .put("nodeId", counter.count)
                .put("className", view.javaClass.name)
                .put("simpleClassName", view.javaClass.simpleName)
                .put("id", if (view.id == View.NO_ID) JSONObject.NULL else view.id)
                .put("resourceName", resourceName(activity, view.id))
                .put("contentDescription", view.contentDescription?.toString() ?: JSONObject.NULL)
                .put("visibility", visibilityName(view.visibility))
                .put("localVisible", localVisible)
                .put("effectiveVisible", effectiveVisible)
                .put("visible", effectiveVisible)
                .put("enabled", view.isEnabled)
                .put("clickable", view.isClickable)
                .put("longClickable", view.isLongClickable)
                .put("focusable", view.isFocusable)
                .put("focused", view.isFocused)
                .put("selected", view.isSelected)
                .put("alpha", view.alpha.toDouble())
                .put(
                    "bounds",
                    JSONObject()
                        .put("left", location[0])
                        .put("top", location[1])
                        .put("right", location[0] + view.width)
                        .put("bottom", location[1] + view.height)
                        .put("width", view.width)
                        .put("height", view.height),
                )
            if (view is TextView) {
                json.put("text", view.text?.toString()?.take(300) ?: "")
            }
            if (view is ViewGroup && depth < 24) {
                val children = JSONArray()
                for (index in 0 until view.childCount) {
                    children.put(viewToJson(activity, view.getChildAt(index), counter, depth + 1, effectiveVisible))
                }
                json.put("children", children)
            }
            return json
        }

        private fun findInputTextTarget(roots: List<WindowRoot>, x: Float, y: Float): TextInputTarget? {
            if (!x.isNaN() && !y.isNaN()) {
                val screenX = x.toInt()
                val screenY = y.toInt()
                roots.asReversed().forEach { root ->
                    if (root.bounds.contains(screenX, screenY) && root.root.isShown) {
                        findEditTextAtPoint(root.root, screenX, screenY)?.let {
                            return TextInputTarget(root, it)
                        }
                    }
                }
            }
            roots.asReversed().forEach { root ->
                findFocusedEditText(root.root)?.let {
                    return TextInputTarget(root, it)
                }
            }
            roots.asReversed().forEach { root ->
                findFirstUsableEditText(root.root)?.let {
                    return TextInputTarget(root, it)
                }
            }
            return null
        }

        private fun findEditTextAtPoint(view: View, x: Int, y: Int): EditText? {
            if (view is ViewGroup) {
                for (index in view.childCount - 1 downTo 0) {
                    findEditTextAtPoint(view.getChildAt(index), x, y)?.let { return it }
                }
            }
            if (view is EditText && isUsableEditText(view) && boundsForView(view).contains(x, y)) {
                return view
            }
            return null
        }

        private fun findFocusedEditText(view: View): EditText? {
            if (view is EditText && view.isFocused && isUsableEditText(view)) {
                return view
            }
            if (view is ViewGroup) {
                for (index in 0 until view.childCount) {
                    findFocusedEditText(view.getChildAt(index))?.let { return it }
                }
            }
            return null
        }

        private fun findFirstUsableEditText(view: View): EditText? {
            if (view is EditText && isUsableEditText(view)) {
                return view
            }
            if (view is ViewGroup) {
                for (index in 0 until view.childCount) {
                    findFirstUsableEditText(view.getChildAt(index))?.let { return it }
                }
            }
            return null
        }

        private fun isUsableEditText(view: EditText): Boolean {
            return view.isShown && view.isEnabled && view.width > 0 && view.height > 0
        }

        private fun editTextToJson(activity: Activity, view: EditText): JSONObject {
            return JSONObject()
                .put("className", view.javaClass.name)
                .put("simpleClassName", view.javaClass.simpleName)
                .put("id", if (view.id == View.NO_ID) JSONObject.NULL else view.id)
                .put("resourceName", resourceName(activity, view.id))
                .put("contentDescription", view.contentDescription?.toString() ?: JSONObject.NULL)
                .put("bounds", rectToJson(boundsForView(view)))
                .put("enabled", view.isEnabled)
                .put("focused", view.isFocused)
                .put("visible", view.isShown)
        }

        private fun windowRoots(activity: Activity): List<WindowRoot> {
            val activityRoot = activity.window?.decorView ?: return emptyList()
            val roots = mutableListOf<WindowRoot>()
            val seen = Collections.newSetFromMap(IdentityHashMap<View, Boolean>())
            reflectWindowRoots().forEach { root ->
                if (root.width <= 0 || root.height <= 0 || !seen.add(root)) {
                    return@forEach
                }
                roots.add(
                    WindowRoot(
                        root = root,
                        bounds = boundsForView(root),
                        type = windowRootType(root, root === activityRoot),
                        activityDecor = root === activityRoot,
                    ),
                )
            }
            if (seen.add(activityRoot)) {
                roots.add(
                    WindowRoot(
                        root = activityRoot,
                        bounds = boundsForView(activityRoot),
                        type = "activity",
                        activityDecor = true,
                    ),
                )
            }
            return roots.ifEmpty {
                listOf(
                    WindowRoot(
                        root = activityRoot,
                        bounds = boundsForView(activityRoot),
                        type = "activity",
                        activityDecor = true,
                    ),
                )
            }
        }

        private fun reflectWindowRoots(): List<View> {
            return try {
                val globalClass = Class.forName("android.view.WindowManagerGlobal")
                val instance = globalClass.getMethod("getInstance").invoke(null)
                val viewsField = globalClass.getDeclaredField("mViews")
                viewsField.isAccessible = true
                when (val rawViews = viewsField.get(instance)) {
                    is List<*> -> rawViews.filterIsInstance<View>()
                    is Array<*> -> rawViews.filterIsInstance<View>()
                    else -> emptyList()
                }
            } catch (_: Throwable) {
                emptyList()
            }
        }

        private fun windowRootType(root: View, activityDecor: Boolean): String {
            if (activityDecor) {
                return "activity"
            }
            val name = root.javaClass.name
            return when {
                name.contains("Popup", ignoreCase = true) -> "popup"
                name.contains("Dialog", ignoreCase = true) -> "dialog"
                else -> "window"
            }
        }

        private fun boundsForView(view: View): Rect {
            val location = IntArray(2)
            view.getLocationOnScreen(location)
            return Rect(location[0], location[1], location[0] + view.width, location[1] + view.height)
        }

        private fun rectToJson(rect: Rect): JSONObject {
            return JSONObject()
                .put("left", rect.left)
                .put("top", rect.top)
                .put("right", rect.right)
                .put("bottom", rect.bottom)
                .put("width", rect.width())
                .put("height", rect.height())
        }

        private fun findSurfaceView(view: View): SurfaceView? {
            if (view is SurfaceView && view.width > 0 && view.height > 0) {
                return view
            }
            if (view is ViewGroup) {
                for (index in 0 until view.childCount) {
                    findSurfaceView(view.getChildAt(index))?.let { return it }
                }
            }
            return null
        }

        private fun findWebViewTarget(view: View): WebViewTarget? {
            webViewAdapters.firstOrNull { adapter ->
                try {
                    adapter.matches(view)
                } catch (_: Throwable) {
                    false
                }
            }?.let { adapter ->
                return WebViewTarget(view, adapter)
            }
            if (view is ViewGroup) {
                for (index in 0 until view.childCount) {
                    findWebViewTarget(view.getChildAt(index))?.let { return it }
                }
            }
            return null
        }

        private fun decodeJavascriptObject(raw: String?): JSONObject {
            val rawValue = raw?.trim()
                ?: throw IllegalArgumentException("empty_javascript_result")
            val firstValue = JSONTokener(rawValue).nextValue()
            return when (firstValue) {
                is JSONObject -> firstValue
                is String -> JSONObject(firstValue)
                else -> JSONObject(firstValue.toString())
            }
        }

        private fun decodeJavascriptValue(raw: String?): Any {
            val rawValue = raw?.trim() ?: return JSONObject.NULL
            if (rawValue.isEmpty() || rawValue == "undefined") {
                return JSONObject.NULL
            }
            return try {
                JSONTokener(rawValue).nextValue()
            } catch (_: Throwable) {
                rawValue
            }
        }

        private fun resourceName(activity: Activity, id: Int): Any {
            if (id == View.NO_ID) {
                return JSONObject.NULL
            }
            return try {
                activity.resources.getResourceName(id)
            } catch (_: Throwable) {
                JSONObject.NULL
            }
        }

        private fun visibilityName(visibility: Int): String {
            return when (visibility) {
                View.VISIBLE -> "visible"
                View.INVISIBLE -> "invisible"
                View.GONE -> "gone"
                else -> visibility.toString()
            }
        }

        @Suppress("DEPRECATION")
        private fun versionCode(packageInfo: android.content.pm.PackageInfo): Long {
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                packageInfo.longVersionCode
            } else {
                packageInfo.versionCode.toLong()
            }
        }

        private fun writeJson(socket: Socket, statusCode: Int, body: JSONObject) {
            val statusText = when (statusCode) {
                200 -> "OK"
                404 -> "Not Found"
                else -> "Internal Server Error"
            }
            val bodyBytes = body.toString().toByteArray(StandardCharsets.UTF_8)
            val header = buildString {
                append("HTTP/1.1 $statusCode $statusText\r\n")
                append("Content-Type: application/json; charset=utf-8\r\n")
                append("Content-Length: ${bodyBytes.size}\r\n")
                append("Connection: close\r\n")
                append("\r\n")
            }.toByteArray(StandardCharsets.UTF_8)
            socket.getOutputStream().apply {
                write(header)
                write(bodyBytes)
                flush()
            }
        }
    }

        private data class HttpRequest(
        val method: String,
        val path: String,
        val query: Map<String, String>,
        val body: String,
    )

    private data class ScreenshotTarget(
        val window: Window,
        val root: View,
        val surfaceView: SurfaceView?,
        val surfaceLeft: Int,
        val surfaceTop: Int,
        val width: Int,
        val height: Int,
    )

    private data class WindowRoot(
        val root: View,
        val bounds: Rect,
        val type: String,
        val activityDecor: Boolean,
    )

    private data class TextInputTarget(
        val root: WindowRoot,
        val view: EditText,
    )

    private class NodeCounter {
        var count: Int = 0
    }
}

