package io.github.mobileaidev.aiappbridge.android

import android.annotation.TargetApi
import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.text.InputType
import android.text.method.PasswordTransformationMethod
import android.util.AtomicFile
import android.util.Base64
import android.util.Log
import android.view.MotionEvent
import android.view.PixelCopy
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.Window
import android.view.inspector.WindowInspector
import android.webkit.WebView
import android.widget.Checkable
import android.widget.EditText
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.io.File
import java.lang.reflect.Proxy
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.Collections
import java.util.IdentityHashMap
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import io.github.mobileaidev.aiappbridge.android.capture.CaptureAppend
import io.github.mobileaidev.aiappbridge.android.capture.CountCaps
import io.github.mobileaidev.aiappbridge.android.capture.LegacyLiveView
import io.github.mobileaidev.aiappbridge.android.capture.MobileCaptureStore

object AiAppBridge {
    private const val tag = "AiAppBridge"
    private const val mainThreadTimeoutMs = 1500L
    private const val pixelCopyTimeoutMs = 1500L
    private const val maxCapturedBodyChars = 20_000
    private const val bridgeVersion = "0.3.3"
    private const val redactedValue = "[redacted]"
    private val runtimeEpoch = "${System.currentTimeMillis()}-${UUID.randomUUID()}"
    @Volatile
    private var flutterActionHandler: FlutterActionHandler? = null

    fun interface FlutterActionHandler {
        fun handle(method: String, payloadJson: String, reply: FlutterActionReply)
    }

    fun interface FlutterActionReply { fun reply(responseJson: String) }

    private val flutterActions = FlutterActionExecutor(
        { flutterActionHandler },
        { JSONObject(flutterSnapshot).optJSONObject("layout")?.optJSONObject("operable")?.optString("runtimeEpoch") },
    )

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

    private val foregroundActivities = ForegroundActivityTracker<Activity>()
    private val explicitActivityStarts = FocusedActivityStart(
        foregroundActivities,
        usable = { !it.isFinishing && !it.isDestroyed && it.window?.decorView != null },
        focused = { it.window.decorView.hasWindowFocus() },
        watchFocus = { activity, gainedFocus ->
            val root = activity.window.decorView
            val listener = ViewTreeObserver.OnWindowFocusChangeListener { focused -> if (focused) gainedFocus() }
            root.viewTreeObserver.addOnWindowFocusChangeListener(listener)
            val remove: () -> Unit = {
                val observer = root.viewTreeObserver
                if (observer.isAlive) observer.removeOnWindowFocusChangeListener(listener)
            }
            remove
        },
        initialized = { ensureUiObserver().attach(it, reason = "bridge-start") },
    )

    @Volatile
    private var factApplicationContext: Context? = null

    internal val observationFactStoreLifecycle by lazy {
        ObservationFactStoreLifecycle(SegmentedFactStore.shared, ::onObservationFactStoreOpened)
    }
    @Volatile private var captureAttachmentState = "not_started"
    @Volatile private var captureAttachmentError: String? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val processLogcatCollector = ProcessLogcatCollector(
        openSource = {
            ProcessLogcatSource(
                ProcessBuilder(logcatFollowCommand()).redirectErrorStream(true).start(),
            )
        },
        persist = { line -> persistLogcatLine(line) },
    )
    private val h5ConsoleLogCollector = H5ConsoleLogCollector(
        mainHandler = mainHandler,
        intervalMs = 500L,
        discover = {
            val activity = activity() ?: return@H5ConsoleLogCollector emptyList()
            AndroidWebViewPages.discover(
                AndroidWebViewPages.activityRoots(activity),
                webViewAdapters.toList(),
            )
        },
        persist = { line -> persistH5ConsoleLine(line) },
    )
    private val captureSequence = AtomicLong(0)
    internal val captureStore = MobileCaptureStore(
        caps = CountCaps(logs = 300, network = 200, events = 300, state = 200),
    )
    @Volatile
    private var uiObserver: AndroidUiObserver? = null
    private val webViewAdapters = CopyOnWriteArrayList<WebViewAdapter>(
        listOf(StandardAndroidWebViewAdapter, ReflectiveJavascriptWebViewAdapter),
    )

    @JvmStatic
    fun start(context: Context) {
        factApplicationContext = context.applicationContext
        ensureUiObserver()
        registerLifecycleCallbacks(context)
        startObservationFactStore(context)
        startAutomaticLogPersist(context)
        if (context is Activity) {
            if (Looper.myLooper() == Looper.getMainLooper()) explicitActivityStarts.start(context)
            else mainHandler.post { explicitActivityStarts.start(context) }
        }
        if (server != null) {
            return
        }
        synchronized(this) {
            if (server != null) {
                return
            }
            server = DebugBridgeServer(context.applicationContext).also {
                it.start()
            }
        }
    }

    @JvmStatic
    fun updateFlutterSnapshot(snapshotJson: String) {
        flutterSnapshot = JSONObject(snapshotJson).toString()
    }

    @JvmStatic
    @Synchronized
    fun setFlutterActionHandler(handler: FlutterActionHandler?) {
        flutterActionHandler = handler
    }

    @JvmStatic
    @Synchronized
    fun clearFlutterActionHandler(handler: FlutterActionHandler): Boolean {
        if (flutterActionHandler !== handler) return false
        flutterActionHandler = null
        return true
    }

    @JvmStatic
    fun checkFlutterAction(body: String): String = flutterActions.check(JSONObject(body)).toString()

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

    /** Flutter owns the async action scope; the native ingress preserves it per record. */
    @JvmStatic
    fun recordFlutterCapture(method: String, payloadJson: String) {
        val payload = JSONObject(payloadJson)
        val source = if (method == "recordNetwork") payload.optString("source", "flutter-sdk") else "flutter-sdk"
        recordExternalCapture(method, payload, source)
    }

    private fun recordExternalCapture(method: String, payload: JSONObject, source: String): JSONObject {
        val actionId = if (payload.has("actionId")) {
            val value = payload.get("actionId")
            require(value is String && value.isNotBlank()) { "actionId must be a non-empty string when present" }
            value
        } else null
        // Even an unassociated Flutter/HTTP record must clear unrelated native thread context.
        return CaptureActionContext.withActionId(actionId) {
            when (method) {
                "recordLog" -> recordLogPayload(payload, source)
                "recordNetwork" -> recordNetworkPayload(payload, source)
                "recordState" -> recordStatePayload(payload, source)
                "recordEvent" -> recordEventPayload(payload, source)
                else -> throw IllegalArgumentException("Unknown capture method: $method")
            }
        }
    }

    private fun ensureUiObserver(): AndroidUiObserver {
        uiObserver?.let { return it }
        synchronized(this) {
            uiObserver?.let { return it }
            return AndroidUiObserver(
                mainHandler = mainHandler,
                eventSink = { category, name, data ->
                    recordEventPayload(
                        JSONObject()
                            .put("category", category)
                            .put("name", name)
                            .put("data", data),
                        source = "ui-observer",
                    )
                },
            ).also { uiObserver = it }
        }
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
                        foregroundActivities.onLifecycle(activity, ActivityPhase.CREATED)
                        uiObserver?.onLifecycle(activity, "created")
                    }

                    override fun onActivityStarted(activity: Activity) {
                        foregroundActivities.onLifecycle(activity, ActivityPhase.STARTED)
                        uiObserver?.onLifecycle(activity, "started")
                    }

                    override fun onActivityResumed(activity: Activity) {
                        explicitActivityStarts.cancel(activity)
                        foregroundActivities.onLifecycle(activity, ActivityPhase.RESUMED)
                        uiObserver?.onLifecycle(activity, "resumed")
                    }

                    override fun onActivityPaused(activity: Activity) {
                        explicitActivityStarts.cancel(activity)
                        foregroundActivities.onLifecycle(activity, ActivityPhase.PAUSED)
                        uiObserver?.onLifecycle(activity, "paused")
                    }

                    override fun onActivityStopped(activity: Activity) {
                        explicitActivityStarts.cancel(activity)
                        foregroundActivities.onLifecycle(activity, ActivityPhase.STOPPED)
                        uiObserver?.onLifecycle(activity, "stopped")
                    }
                    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

                    override fun onActivityDestroyed(activity: Activity) {
                        explicitActivityStarts.cancel(activity)
                        foregroundActivities.onLifecycle(activity, ActivityPhase.DESTROYED)
                        uiObserver?.onLifecycle(activity, "destroyed")
                    }
                },
            )
            lifecycleRegistered = true
        }
    }

    private fun activity(): Activity? = foregroundActivities.current()

    private fun runOnMainThread(mutation: Boolean = false, block: () -> JSONObject): JSONObject {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return try { block() } catch (failure: NativeTargetFailure) { failure.response() }
        }
        val latch = CountDownLatch(1)
        val result = AtomicReference<JSONObject>()
        val error = AtomicReference<Throwable>()
        val gate = MainThreadTaskGate()
        val task = Runnable {
            if (!gate.begin()) { latch.countDown(); return@Runnable }
            try {
                result.set(block())
            } catch (throwable: Throwable) {
                error.set(throwable)
            } finally {
                latch.countDown()
            }
        }
        if (!mainHandler.post(task)) return NativeTargetFailure("main_thread_unavailable").response()
        fun abortWait(code: String): JSONObject {
            val cancelledQueued = gate.cancelQueued()
            if (cancelledQueued) mainHandler.removeCallbacks(task)
            return NativeTargetFailure(code).response()
                .put("dispatched", if (mutation && !cancelledQueued) JSONObject.NULL else false)
                .put("ambiguous", mutation && !cancelledQueued)
        }
        val completed = try { latch.await(mainThreadTimeoutMs, TimeUnit.MILLISECONDS) }
        catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            return abortWait("main_thread_interrupted")
        }
        if (!completed) return abortWait("main_thread_timeout")
        error.get()?.let { if (it is NativeTargetFailure) return it.response() else throw it }
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
        CaptureAppend.appendSanitized(
            captureStore,
            event,
            targetKey = captureTargetKey(),
            runtimeEpoch = runtimeEpoch,
        )
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
        CaptureAppend.appendSanitized(
            captureStore,
            event,
            targetKey = captureTargetKey(),
            runtimeEpoch = runtimeEpoch,
        )
        return event
    }

    private fun recordStatePayload(payload: JSONObject, source: String): JSONObject {
        val namespace = payload.optString("namespace", "app").ifBlank { "app" }
        val key = payload.optString("key", "value").ifBlank { "value" }
        val event = baseCapture(type = "state", source = source)
            .put("namespace", namespace)
            .put("key", key)
            .put("value", if (payload.has("value")) payload.opt("value") else JSONObject.NULL)
        CaptureAppend.appendSanitized(
            captureStore,
            event,
            targetKey = captureTargetKey(),
            runtimeEpoch = runtimeEpoch,
        )
        return event
    }

    private fun recordEventPayload(payload: JSONObject, source: String): JSONObject {
        val event = baseCapture(type = "event", source = source)
            .put("category", payload.optString("category", "app"))
            .put("name", payload.optString("name", "event"))
        if (payload.has("data")) {
            event.put("data", payload.opt("data"))
        }
        CaptureAppend.appendSanitized(
            captureStore,
            event,
            targetKey = captureTargetKey(),
            runtimeEpoch = runtimeEpoch,
        )
        return event
    }

    private fun startObservationFactStore(context: Context?) {
        val target = context ?: factApplicationContext ?: activity() ?: return
        try {
            val configuration = MobileFactStoreProfiles.forContext(target)
            if (!captureStore.status().persistent) captureAttachmentState = "opening"
            observationFactStoreLifecycle.start(configuration)
        } catch (error: Throwable) {
            captureAttachmentState = "failed"
            captureAttachmentError = error.message ?: error.javaClass.name
            Log.w(tag, "failed to configure observation fact store", error)
        }
    }

    private fun onObservationFactStoreOpened(
        configuration: MobileFactStoreConfiguration,
        operation: SegmentedFactStoreOperationResult,
    ) {
        if (!operation.isSuccess || !configuration.options.enabled) {
            captureAttachmentState = if (configuration.options.enabled) "failed" else "disabled"
            captureAttachmentError = if (configuration.options.enabled) operation.message else configuration.disabledReason
            Log.w(tag, "capture persistence open ${operation.code}: ${captureAttachmentError}")
            return
        }
        // This callback is emitted for every actual open, including a reopen after maintenance.
        // The status/attachment task stays on the writer, after the store becomes readable.
        SegmentedFactStore.shared.status { status ->
            if (status.state != SegmentedFactStoreState.OPEN || !status.operation.isSuccess) {
                captureAttachmentState = "failed"
                captureAttachmentError = "capture store state ${status.state}: ${status.operation.message}"
                return@status
            }
            try {
                captureStore.usePersistentStore(SegmentedFactStore.shared, configuration.options.directory,
                    captureTargetKey(), runtimeEpoch, epochStartSequence = status.nextSequence - 1,
                    existingRecords = status.recordCount)
                captureAttachmentState = "attached"
                captureAttachmentError = null
            } catch (error: Throwable) {
                captureAttachmentState = "failed"
                captureAttachmentError = error.message ?: error.javaClass.name
                Log.w(tag, "failed to attach persistent capture store", error)
            }
        }
    }

    internal fun capturePersistenceStatus(): JSONObject {
        val lifecycle = observationFactStoreLifecycle.snapshot()
        return JSONObject()
            .put("persistent", captureStore.status().persistent)
            .put("attachmentState", captureAttachmentState)
            .put("attachmentError", captureAttachmentError ?: JSONObject.NULL)
            .put("lifecycleState", lifecycle.lifecycleState.name)
            .put("profile", lifecycle.profile ?: JSONObject.NULL)
            .put("directory", lifecycle.directory ?: JSONObject.NULL)
            .put("disabledReason", lifecycle.disabledReason ?: JSONObject.NULL)
            .put("operation", JSONObject().put("code", lifecycle.store.operation.code)
                .put("systemCode", lifecycle.store.operation.systemCode).put("message", lifecycle.store.operation.message))
    }

    private fun stopObservationFactStoreForMaintenance(timeoutMs: Long = 2_000L): Boolean {
        observationFactStoreLifecycle.stop()
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (System.nanoTime() < deadline) {
            if (observationFactStoreLifecycle.snapshot().lifecycleState == SegmentedFactStoreState.CLOSED) {
                return true
            }
            try {
                Thread.sleep(10L)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return false
            }
        }
        return observationFactStoreLifecycle.snapshot().lifecycleState == SegmentedFactStoreState.CLOSED
    }

    private fun startAutomaticLogPersist(context: Context) {
        try {
            if (isMainProcess(context.applicationContext)) {
                processLogcatCollector.start()
            }
            h5ConsoleLogCollector.start()
        } catch (_: Throwable) {
        }
    }

    private fun persistLogcatLine(line: CapturedLogLine) {
        val data = JSONObject()
            .put("pid", line.processId)
            .put("time", line.time)
            .put("raw", line.raw)
        persistCapturedLog(
            source = "logcat",
            level = line.level,
            tag = line.tag,
            message = line.message,
            data = data,
            partition = LogcatLineParser.partition(line.processId, android.os.Process.myPid()),
        )
    }

    private fun persistH5ConsoleLine(line: H5ConsoleLine) {
        persistCapturedLog(
            source = "console",
            level = if (line.method == "log") "info" else line.method,
            tag = "console",
            message = line.message,
            data = JSONObject()
                .put("method", line.method)
                .put("atMs", line.atMs),
            partition = MobileFactPartition.APP_LOG,
            occurredAtMs = line.atMs.takeIf { it > 0L },
        )
    }

    private fun persistCapturedLog(
        source: String,
        level: String,
        tag: String,
        message: String,
        data: JSONObject?,
        partition: MobileFactPartition,
        occurredAtMs: Long? = null,
    ) {
        val event = JSONObject()
            .put("type", "log")
            .put("source", source)
            .put("level", level)
            .put("tag", tag)
            .put("message", message)
            .put("timestampMs", occurredAtMs ?: System.currentTimeMillis())
        data?.let { event.put("data", it) }
        persistMobileFact(event) { context ->
            if (partition == MobileFactPartition.DEVICE_LOG) {
                SanitizedFactPayload.deviceLog(context, event)
            } else {
                SanitizedFactPayload.log(context, event)
            }
        }
    }

    private fun persistMobileFact(
        event: JSONObject,
        factory: (MobileFactEnvelopeContext) -> SanitizedFactPayload,
    ) {
        try {
            AndroidObservationFactStoreRegistry.enqueue(factory(mobileFactContext(event)))
        } catch (_: Throwable) {
            // Persistent observation is additive and must never affect the host app.
        }
    }

    private fun captureTargetKey(): String {
        val context = factApplicationContext ?: activity()?.applicationContext
        return context?.packageName ?: "unknown"
    }

    private fun mobileFactContext(event: JSONObject? = null): MobileFactEnvelopeContext {
        val context = factApplicationContext ?: activity()?.applicationContext
        val packageName = context?.packageName ?: "unknown"
        val rawDeviceIdentity = try {
            context?.contentResolver?.let {
                Settings.Secure.getString(it, Settings.Secure.ANDROID_ID)
            }
        } catch (_: Throwable) {
            null
        } ?: "${Build.MANUFACTURER}:${Build.MODEL}:${Build.FINGERPRINT}"
        val nowMs = System.currentTimeMillis()
        val occurredAtMs = event?.optLong("timestampMs", nowMs) ?: nowMs
        val actionId = event?.optString("actionId")?.takeIf { it.isNotBlank() }
            ?: CaptureActionContext.currentActionId()
        return MobileFactEnvelopeContext(
            platform = "android",
            packageName = packageName,
            bundleId = null,
            model = Build.MODEL,
            deviceIdentity = SanitizedFactPayload.stableDeviceIdentity(
                platform = "android",
                appIdentifier = packageName,
                rawIdentity = rawDeviceIdentity,
            ),
            runtimeEpoch = runtimeEpoch,
            actionId = actionId,
            occurredAtMs = occurredAtMs,
            observedAtMs = nowMs,
        )
    }

    private fun baseCapture(type: String, source: String): JSONObject {
        return JSONObject()
            .put("id", captureSequence.incrementAndGet())
            .put("type", type)
            .put("source", source)
            .put("timestampMs", System.currentTimeMillis())
            .also { event ->
                CaptureActionContext.currentActionId()?.let { event.put("actionId", it) }
            }
    }

    private fun captureCounts(): JSONObject {
        val streams = captureStore.status().streams
        return JSONObject()
            .put("logs", streams.getValue("logs").count)
            .put("network", streams.getValue("network").count)
            .put("state", streams.getValue("state").count)
            .put("events", streams.getValue("events").count)
    }

    private fun buildLogs(query: Map<String, String> = emptyMap()): JSONObject {
        return LegacyLiveView.fromHttp(captureStore, "logs", query, System.currentTimeMillis())
    }

    private fun buildNetwork(query: Map<String, String> = emptyMap()): JSONObject {
        return LegacyLiveView.fromHttp(captureStore, "network", query, System.currentTimeMillis())
    }

    private fun buildEvents(query: Map<String, String> = emptyMap()): JSONObject {
        return LegacyLiveView.fromHttp(captureStore, "events", query, System.currentTimeMillis())
    }

    private fun buildState(query: Map<String, String> = emptyMap()): JSONObject {
        return LegacyLiveView.fromHttp(captureStore, "state", query, System.currentTimeMillis())
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
        val event = recordExternalCapture("recordLog", requestJson(body), source = "http")
        return JSONObject().put("ok", true).put("event", event)
    }

    private fun postNetwork(body: String): JSONObject {
        val event = recordExternalCapture("recordNetwork", requestJson(body), source = "http")
        return JSONObject().put("ok", true).put("event", event)
    }

    private fun postState(body: String): JSONObject {
        val event = recordExternalCapture("recordState", requestJson(body), source = "http")
        return JSONObject().put("ok", true).put("event", event)
    }

    private fun postEvent(body: String): JSONObject {
        val event = recordExternalCapture("recordEvent", requestJson(body), source = "http")
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
        val normalized = key.lowercase().replace(Regex("[^a-z0-9]"), "")
        return normalized == "authorization" ||
            normalized == "proxyauthorization" ||
            normalized == "password" ||
            normalized == "passwd" ||
            normalized == "pwd" ||
            normalized == "passcode" ||
            normalized.endsWith("password") ||
            normalized == "token" ||
            normalized.endsWith("token")
    }

    private fun jsonStringOrNull(json: JSONObject, key: String): String? {
        if (!json.has(key) || json.isNull(key)) {
            return null
        }
        return json.optString(key)
    }

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
    ) {
        private val socketName = "aab-sdk-$runtimeEpoch"
        private val executor = Executors.newSingleThreadExecutor { task ->
            Thread(task, "ai-app-bridge").apply { isDaemon = true }
        }
        private val nativeGestures = NativeGestureExecutor(mainHandler, { actionId, data ->
            CaptureActionContext.withActionId(actionId) { uiObserver?.noteGesture(data) }
        })
        private val nativeActions = ManagedActionExecutor(ManagedActionProtocol.NATIVE, runtimeEpoch, settledEvent = { result ->
            CaptureActionContext.withActionId(result.getString("actionId")) {
                val data = JSONObject().put("execution", result.getJSONObject("execution"))
                    .put("ok", result.getBoolean("ok")).put("dispatched", result.getBoolean("dispatched"))
                    .put("ambiguous", result.getBoolean("ambiguous")).put("error", result.opt("error") ?: JSONObject.NULL)
                recordEvent("interaction", "native.action.settled", data.toString())
            }
        })
        private val h5Actions = ManagedActionExecutor(ManagedActionProtocol.H5, runtimeEpoch, settledEvent = { result ->
            CaptureActionContext.withActionId(result.getString("actionId")) {
                val data = JSONObject().put("execution", result.getJSONObject("execution"))
                    .put("ok", result.getBoolean("ok")).put("dispatched", result.getBoolean("dispatched"))
                    .put("ambiguous", result.getBoolean("ambiguous")).put("error", result.opt("error") ?: JSONObject.NULL)
                recordEvent("interaction", "h5.action.settled", data.toString())
            }
        })
        private val h5Bridge = AndroidH5Bridge(runtimeEpoch, context.packageName, { webViewAdapters.toList() }) {
            val activity = activity() ?: throw H5EvaluationFailure("no_current_activity")
            val window = foregroundH5Window(activity)
            AndroidH5Bridge.Window(window.root, activity.javaClass.name, window.type)
        }
        private val actionReplies = java.util.concurrent.ThreadPoolExecutor(2, 2, 0L,
            java.util.concurrent.TimeUnit.MILLISECONDS, java.util.concurrent.ArrayBlockingQueue(16),
            { task -> Thread(task, "aab-action-reply").apply { isDaemon = true } })

        fun start() {
            executor.execute {
                try {
                    writeEndpointState(ok = false, error = "starting")
                    val serverSocket = LocalServerSocket(socketName)
                    try {
                        writeEndpointState(ok = true, error = null)
                        Log.i(tag, "AI app bridge listening on localabstract:$socketName")
                        while (!Thread.currentThread().isInterrupted) {
                            handleClient(serverSocket.accept())
                        }
                    } finally {
                        serverSocket.close()
                    }
                } catch (error: Throwable) {
                    Log.w(tag, "AI app bridge stopped", error)
                    try { writeEndpointState(ok = false, error = error.javaClass.simpleName) }
                    catch (stateError: Throwable) { Log.w(tag, "AI app bridge failed to write endpoint state", stateError) }
                }
            }
        }

        private fun writeEndpointState(ok: Boolean, error: String?) {
            val payload = JSONObject()
                .put("schema", "ai-app-bridge.android-endpoint.v1")
                .put("ok", ok)
                .put("packageName", context.packageName)
                .put("runtimeEpoch", runtimeEpoch)
                .put("transport", "localabstract")
                .put("socketName", socketName)
                .put("version", bridgeVersion)
                .put("updatedAtMs", System.currentTimeMillis())
                .put("error", error ?: JSONObject.NULL)
            val file = AtomicFile(File(context.filesDir, "ai_app_bridge_endpoint.json"))
            val output = file.startWrite()
            try {
                output.write(payload.toString().toByteArray(StandardCharsets.UTF_8))
                file.finishWrite(output)
            } catch (failure: Throwable) {
                file.failWrite(output)
                throw failure
            }
        }

        private fun enqueueActionReply(socket: LocalSocket, response: JSONObject) {
            try { actionReplies.execute { replyGesture(socket, 200, response) } }
            catch (_: java.util.concurrent.RejectedExecutionException) {
                try { socket.close() } catch (_: java.io.IOException) { }
            }
        }

        private fun handleClient(socket: LocalSocket) {
            val request = try { readRequest(socket) }
            catch (error: Throwable) { replyGesture(socket, 500, JSONObject().put("ok", false).put("error", error.toString())); return }
            if (request.method == "POST" && request.path in setOf("/v1/action/tap", "/v1/action/tap-target",
                    "/v1/action/input-text", "/v1/action/input-target", "/v1/action/gesture-target", "/v1/action/cancel")) {
                val body = try { requestJson(request.body) }
                catch (_: org.json.JSONException) { replyGesture(socket, 200, NativeTargetFailure("invalid_json").response()); return }
                val reply: (JSONObject) -> Unit = { response -> enqueueActionReply(socket, response) }
                if (request.path == "/v1/action/cancel") nativeActions.cancel(body, reply)
                else if (flutterActions.isBusy()) reply(NativeTargetFailure("flutter_action_busy").response())
                else if (h5Actions.isBusy()) reply(h5Failure("h5_action_busy"))
                else {
                    val kind = when (request.path) {
                        "/v1/action/gesture-target" -> "gesture"
                        "/v1/action/tap", "/v1/action/tap-target" -> "tap"
                        else -> "input"
                    }
                    nativeActions.submit(kind, body, {
                        when (kind) {
                            "gesture" -> {
                                val gesture = NativeGestureContract.parse(body)
                                nativeGestures.task(gesture) { prepareNativeGesture(gesture) }
                            }
                            else -> {
                                val semantic = request.path.endsWith("-target")
                                if (semantic) NativeTargetContract.validateRequest(body, input = kind == "input")
                                else NativeTargetContract.validatePointRequest(body, input = kind == "input")
                                NativeMainThreadTask(mainHandler) { mutation ->
                                    if (kind == "tap") dispatchTap(body, semantic, mutation) else dispatchInputText(body, semantic, mutation)
                                }
                            }
                        }
                    }, reply)
                }
                return
            }
            if (request.method == "POST" && request.path in setOf("/v1/flutter/action", "/v1/flutter/cancel")) {
                val body = try { requestJson(request.body) }
                catch (_: org.json.JSONException) { replyGesture(socket, 200, NativeTargetFailure("invalid_json").response()); return }
                val reply: (JSONObject) -> Unit = { response -> enqueueActionReply(socket, response) }
                if (request.path == "/v1/flutter/cancel") flutterActions.cancel(body, reply)
                else if (nativeActions.isBusy()) reply(NativeTargetFailure("native_action_busy").response())
                else if (h5Actions.isBusy()) reply(h5Failure("h5_action_busy"))
                else flutterActions.submit(body, reply)
                return
            }
            if (request.method == "POST" && request.path in setOf("/v1/h5/action", "/v1/h5/cancel")) {
                val body = try { requestJson(request.body) }
                catch (_: org.json.JSONException) { replyGesture(socket, 200, h5Failure("invalid_json")); return }
                val reply: (JSONObject) -> Unit = { response -> enqueueActionReply(socket, response) }
                if (request.path == "/v1/h5/cancel") h5Actions.cancel(body, reply)
                else if (nativeActions.isBusy()) reply(h5Failure("native_action_busy"))
                else if (flutterActions.isBusy()) reply(h5Failure("flutter_action_busy"))
                else if (body.keys().asSequence().toSet() != setOf("payload", "actionId", "execution") || body.opt("payload") !is JSONObject) {
                    reply(h5Failure("invalid_h5_request"))
                } else h5Actions.submit(body.getJSONObject("payload").optString("action"), body, {
                    val payload = body.getJSONObject("payload")
                    AndroidH5Bridge.validate(payload)
                    H5EvaluationTask(mainHandler::post, mainHandler::removeCallbacks) { check -> h5Bridge.prepare(payload, check) }
                }, reply)
                return
            }
            socket.use {
                try {
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
                            writeJson(socket, 200, buildH5Dom(request.query["webViewId"]))
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
                        request.method == "POST" && request.path == "/v1/app/clear-data" -> {
                            writeJson(socket, 200, clearAppData())
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
                    try { writeJson(
                        socket,
                        500,
                        JSONObject().put("ok", false).put("error", error.toString()),
                    ) } catch (closed: java.io.IOException) { Log.w(tag, "AI app bridge response connection closed", closed) }
                }
            }
        }

        private fun replyGesture(socket: LocalSocket, status: Int, response: JSONObject) {
            socket.use {
                try { writeJson(socket, status, response) }
                catch (error: java.io.IOException) { Log.w(tag, "SDK action response connection closed", error) }
            }
        }

        private fun readRequest(socket: LocalSocket): HttpRequest {
            socket.soTimeout = 1500
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

        private fun clearAppData(): JSONObject {
            if (nativeActions.isBusy()) return NativeTargetFailure("native_action_busy").response()
            if (flutterActions.isBusy()) return NativeTargetFailure("flutter_action_busy").response()
            if (h5Actions.isBusy()) return h5Failure("h5_action_busy")
            val cleared = JSONArray()
            val failures = JSONArray()
            if (!stopObservationFactStoreForMaintenance()) {
                return JSONObject().put("ok", false).put("error", "capture_store_close_timeout")
            }
            if (!captureStore.clear().ok) {
                return JSONObject().put("ok", false).put("error", "capture_store_clear_failed")
            }
            captureStore.detachPersistentStore()
            cleared.put("runtime-captures")

            context.databaseList().forEach { databaseName ->
                if (context.deleteDatabase(databaseName)) {
                    cleared.put("database:$databaseName")
                } else {
                    failures.put("database:$databaseName")
                }
            }

            deletePathContents("files", context.filesDir, cleared, failures)
            deletePathContents("cache", context.cacheDir, cleared, failures)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                deletePathContents("code-cache", context.codeCacheDir, cleared, failures)
                deletePathContents("no-backup", context.noBackupFilesDir, cleared, failures)
            }
            context.getExternalFilesDirs(null).forEachIndexed { index, dir ->
                deletePathContents("external-files-$index", dir, cleared, failures)
            }
            context.externalCacheDirs.forEachIndexed { index, dir ->
                deletePathContents("external-cache-$index", dir, cleared, failures)
            }

            val dataDir = File(context.applicationInfo.dataDir)
            deletePathContents("shared-prefs", File(dataDir, "shared_prefs"), cleared, failures)
            deletePathContents("datastore", File(dataDir, "datastore"), cleared, failures)
            deletePathContents("app-webview", File(dataDir, "app_webview"), cleared, failures)
            writeEndpointState(ok = true, error = null)
            startObservationFactStore(context)

            return JSONObject()
                .put("ok", failures.length() == 0)
                .put("action", "clear-app-data")
                .put(
                    "app",
                    JSONObject()
                        .put("packageName", context.packageName),
                )
                .put("cleared", cleared)
                .put("failures", failures)
                .put("updatedAtMs", System.currentTimeMillis())
        }

        private fun deletePathContents(
            label: String,
            directory: File?,
            cleared: JSONArray,
            failures: JSONArray,
        ) {
            if (directory == null || !directory.exists()) {
                return
            }
            val children = directory.listFiles()
            if (children == null) {
                failures.put(label)
                return
            }
            var deleted = 0
            children.forEach { child ->
                if (child.deleteRecursively()) {
                    deleted += 1
                } else {
                    failures.put("$label/${child.name}")
                }
            }
            cleared.put(JSONObject().put("path", label).put("entries", deleted))
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
                        .put("transport", "localabstract")
                        .put("runtimeEpoch", runtimeEpoch)
                        .put("nativeTargetSchema", NativeTargetContract.SCHEMA)
                        .put("nativeExecutionSchema", ManagedActionProtocol.NATIVE.schema)
                        .put("h5ExecutionSchema", ManagedActionProtocol.H5.schema)
                        .put("h5TargetSchema", AndroidH5Bridge.SCHEMA)
                        .put("h5Action", h5Actions.status() ?: JSONObject.NULL)
                        .put("nativeAction", nativeActions.status() ?: JSONObject.NULL)
                        .put("flutterAction", flutterActions.status() ?: JSONObject.NULL)
                        .put("captureTargetKey", captureTargetKey())
                        .put("socketName", socketName),
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
                .put("capturePersistence", capturePersistenceStatus())
                .put("flutter", JSONObject(AiAppBridge.flutterSnapshot))
                .put("updatedAtMs", System.currentTimeMillis())
        }

        private fun buildViewTree(): JSONObject {
            return runOnMainThread {
                val activity = activity()
                    ?: return@runOnMainThread JSONObject()
                        .put("ok", false)
                        .put("error", "no_current_activity")
                nativeSnapshot(activity).json
            }
        }

        private fun nativeSnapshot(activity: Activity): NativeViewSnapshot {
            val root = activity.window?.decorView ?: throw NativeTargetFailure("no_decor_view")
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
                        .put("windowId", viewIdentity(windowRoot.root))
                        .put("focused", windowRoot.root.hasWindowFocus())
                        .put("focusable", windowRoot.focusable)
                        .put("touchable", windowRoot.touchable)
                        .put("focusOwnerWindowId", windowRoot.focusOwnerWindowId ?: JSONObject.NULL)
                        .put("bounds", rectToJson(windowRoot.bounds))
                        .put("root", viewToJson(activity, windowRoot.root, counter, depth = 0, parentEffectiveVisible = true)),
                )
            }
            val json = JSONObject()
                .put("ok", true)
                .put("activity", activity.javaClass.name)
                .put("root", viewToJson(activity, root, counter, depth = 0, parentEffectiveVisible = true))
                .put("windows", windows)
                .put("windowCount", roots.size)
                .put("nodeCount", counter.count)
                .put("updatedAtMs", System.currentTimeMillis())
            return NativeViewSnapshot(json, roots, counter.views)
        }

        private fun buildH5Dom(webViewId: String?): JSONObject {
            val latch = CountDownLatch(1)
            val result = AtomicReference<JSONObject>()
            mainHandler.post {
                try {
                    h5Bridge.snapshot(webViewId) { value -> result.set(value); latch.countDown() }
                } catch (error: Throwable) {
                    result.set(h5Failure("h5_snapshot_failed").put("message", error.toString()))
                    latch.countDown()
                }
            }
            if (!latch.await(mainThreadTimeoutMs, TimeUnit.MILLISECONDS)) return h5Failure("h5_dom_timeout")
            return result.get() ?: h5Failure("empty_h5_dom_result")
        }

        private fun foregroundH5Window(activity: Activity): WindowRoot = try {
            foregroundActionWindow(activity)
        } catch (error: NativeTargetFailure) {
            throw H5EvaluationFailure(error.code)
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

        private fun dispatchTap(request: JSONObject, semantic: Boolean, mutation: NativeMutationGate): JSONObject {
            val actionId = request.getString("actionId")
            val activity = activity() ?: throw NativeTargetFailure("no_current_activity")
            val resolved = if (semantic) resolveNativeTarget(activity, request, editable = false) else null
            val x = resolved?.selection?.x?.toFloat() ?: request.getDouble("x").toFloat()
            val y = resolved?.selection?.y?.toFloat() ?: request.getDouble("y").toFloat()
            val target = resolved?.root ?: foregroundActionWindow(activity)
            if (!target.bounds.contains(x.toInt(), y.toInt())) throw NativeTargetFailure("native_point_outside_foreground_window")
            val hitView = findActionViewAtPoint(target.root, x.toInt(), y.toInt())
            val localX = x - target.bounds.left
            val localY = y - target.bounds.top
            val response = CaptureActionContext.withActionId(actionId) {
                val hitTarget = hitView?.let { actionViewToJson(activity, it) }
                val downTime = SystemClock.uptimeMillis()
                val eventTime = downTime + 48L
                val down = nativeTouchEvent(downTime, downTime, MotionEvent.ACTION_DOWN, x, y, target.bounds)
                val up = nativeTouchEvent(downTime, eventTime, MotionEvent.ACTION_UP, x, y, target.bounds)
                var downSent = false
                var upReturned = false
                val handledDown: Boolean
                val handledUp: Boolean
                try {
                    mutation.dispatch(); downSent = true
                    handledDown = target.root.dispatchTouchEvent(down)
                    mutation.dispatch()
                    handledUp = target.root.dispatchTouchEvent(up); upReturned = true
                } catch (error: Throwable) {
                    if (downSent && !upReturned) {
                        val cancel = nativeTouchEvent(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_CANCEL, x, y, target.bounds)
                        try { target.root.dispatchTouchEvent(cancel) } catch (failure: Throwable) { error.addSuppressed(failure) }
                        finally { cancel.recycle() }
                    }
                    throw error
                } finally { down.recycle(); up.recycle() }
                uiObserver?.noteTap(
                    x = x,
                    y = y,
                    windowType = target.type,
                    target = hitTarget,
                    handledDown = handledDown,
                    handledUp = handledUp,
                )
                JSONObject()
                    .put("ok", true)
                    .put("dispatched", true)
                    .put("ambiguous", false)
                    .put("targetValidation", if (semantic) NativeTargetContract.SCHEMA else "coordinates")
                    .put("targetRef", resolved?.selection?.node?.optJSONObject("targetRef") ?: JSONObject.NULL)
                    .put("x", x.toDouble())
                    .put("y", y.toDouble())
                    .put("localX", localX.toDouble())
                    .put("localY", localY.toDouble())
                    .put("windowType", target.type)
                    .put("rootClassName", target.root.javaClass.name)
                    .put("rootBounds", rectToJson(target.bounds))
                    .put("target", hitTarget ?: JSONObject.NULL)
                    .put("handledDown", handledDown)
                    .put("handledUp", handledUp)
                    .put("actionId", actionId ?: JSONObject.NULL)
                    .put("updatedAtMs", System.currentTimeMillis())
            }
            CaptureActionContext.deferActionId(actionId) { clear -> mainHandler.post(clear) }
            return response
        }

        private fun dispatchInputText(request: JSONObject, semantic: Boolean, mutation: NativeMutationGate): JSONObject {
            val actionId = request.getString("actionId")
            val text = request.getString("text")
            val activity = activity() ?: throw NativeTargetFailure("no_current_activity")
            val resolved = if (semantic) resolveNativeTarget(activity, request, editable = true) else null
            val target = if (resolved != null) TextInputTarget(resolved.root, resolved.view as EditText) else {
                val window = foregroundActionWindow(activity)
                findInputTextTarget(listOf(window), request.optDouble("x", Double.NaN).toFloat(), request.optDouble("y", Double.NaN).toFloat())
                    ?: throw NativeTargetFailure("input_target_not_found")
            }
            if (!target.root.root.hasWindowFocus()) throw NativeTargetFailure("native_input_window_not_focused")
            val response = CaptureActionContext.withActionId(actionId) {
                mutation.dispatch()
                val requestedFocus = target.view.requestFocus()
                if (!target.view.isFocused) return@withActionId NativeTargetFailure("input_focus_rejected", dispatched = true).response()
                mutation.dispatch()
                val connection = target.view.onCreateInputConnection(android.view.inputmethod.EditorInfo())
                    ?: return@withActionId NativeTargetFailure("input_connection_unavailable", dispatched = true).response()
                try {
                    // Every input path keeps the editor/window selected before focus.
                    // App callbacks may change that binding without changing its text.
                    validateInputBinding(activity, target, if (semantic) request else null)
                    // Use the editor's IME contract. Custom EditText.setText overrides
                    // can deliberately suppress the listeners that update app state.
                    mutation.dispatch()
                    connection.beginBatchEdit()
                    val committed = try {
                        mutation.dispatch()
                        if (!connection.setSelection(0, target.view.text?.length ?: 0)) false
                        else {
                            validateInputBinding(activity, target, if (semantic) request else null)
                            mutation.dispatch()
                            connection.commitText(text, 1)
                        }
                    } finally {
                        connection.endBatchEdit()
                    }
                    if (!committed) {
                        return@withActionId NativeTargetFailure("input_connection_rejected", dispatched = true).response()
                    }
                    uiObserver?.noteInput(
                        inputLength = text.length,
                        windowType = target.root.type,
                        targetClassName = target.view.javaClass.name,
                        targetResourceName = resourceName(activity, target.view.id).toString(),
                    )
                    JSONObject()
                        .put("ok", true)
                        .put("dispatched", true)
                        .put("ambiguous", false)
                        .put("targetValidation", if (semantic) NativeTargetContract.SCHEMA else "coordinates-or-focus")
                        .put("targetRef", resolved?.selection?.node?.optJSONObject("targetRef") ?: JSONObject.NULL)
                        .put("transport", "bridge")
                        .put("source", "native-view")
                        .put("text", text)
                        .put("textLength", text.length)
                        .put("requestedFocus", requestedFocus)
                        .put("focused", target.view.isFocused)
                        .put("windowType", target.root.type)
                        .put("target", editTextToJson(activity, target.view))
                        .put("actionId", actionId ?: JSONObject.NULL)
                        .put("updatedAtMs", System.currentTimeMillis())
                } catch (failure: NativeTargetFailure) {
                    NativeTargetFailure(failure.code, failure.field, dispatched = true).response()
                } finally {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) connection.closeConnection()
                }
            }
            CaptureActionContext.deferActionId(actionId) { clear -> mainHandler.post(clear) }
            return response
        }

        private fun validateInputBinding(activity: Activity, target: TextInputTarget, semanticRequest: JSONObject?) {
            if (activity() !== activity || foregroundActionWindow(activity).root !== target.root.root) {
                throw NativeTargetFailure("native_window_changed")
            }
            if (!target.view.isAttachedToWindow || target.view.rootView !== target.root.root) {
                throw NativeTargetFailure("native_target_replaced")
            }
            if (!target.root.root.hasWindowFocus()) throw NativeTargetFailure("native_input_window_not_focused")
            if (!target.view.isFocused) throw NativeTargetFailure("input_focus_changed")
            if (!target.view.isShown || !target.view.isEnabled || target.view.alpha <= 0f) {
                throw NativeTargetFailure("input_target_not_operable")
            }
            if (semanticRequest != null) resolveNativeTarget(activity, semanticRequest, editable = true)
        }

        private fun resolveNativeTarget(activity: Activity, request: JSONObject, editable: Boolean): ResolvedNativeTarget {
            val resolved = resolveNativeSelection(activity, request, editable)
            val hit = findActionViewAtPoint(resolved.root.root, resolved.selection.x, resolved.selection.y)
            val ownsPoint = if (editable) targetContainsView(hit, resolved.view) else nativePointerOwnsHit(resolved.view, hit)
            if (!ownsPoint) throw NativeTargetFailure("native_target_obscured")
            return resolved
        }

        private fun resolveNativeSelection(activity: Activity, request: JSONObject, editable: Boolean): ResolvedNativeTarget {
            val snapshot = nativeSnapshot(activity)
            val selection = NativeTargetContract.resolve(snapshot.json, request.getJSONObject("selector"), request.getJSONObject("targetRef"), editable)
            val ref = selection.node.getJSONObject("targetRef")
            val root = snapshot.roots.single { viewIdentity(it.root) == ref.getString("windowId") }
            val view = snapshot.views[ref.getString("viewId")] ?: throw NativeTargetFailure("native_target_replaced")
            return ResolvedNativeTarget(selection, root, view)
        }

        private fun prepareNativeGesture(request: NativeGestureRequest): NativeGestureTarget {
            val owner = activity() ?: throw NativeTargetFailure("no_current_activity")
            val selected = resolveNativeSelection(owner, request.body, editable = false)
            val root = selected.root
            var startX = selected.selection.x
            var startY = selected.selection.y
            var endX = startX
            var endY = startY
            if (request.action == "scroll") {
                val direction = if (request.direction == "down") 1 else -1
                if (!selected.view.canScrollVertically(direction)) throw NativeTargetFailure("native_scroll_boundary")
                val visible = Rect()
                if (!selected.view.getGlobalVisibleRect(visible)) throw NativeTargetFailure("native_target_obscured")
                val origin = IntArray(2).also(selected.view.rootView::getLocationOnScreen)
                visible.offset(origin[0], origin[1])
                if (!visible.intersect(root.bounds)) throw NativeTargetFailure("native_target_obscured")
                startX = visible.centerX(); endX = startX
                startY = Math.round(visible.top + visible.height() * if (direction > 0) .76f else .22f)
                endY = Math.round(visible.top + visible.height() * if (direction > 0) .22f else .76f)
            } else if (request.action == "swipe") {
                val x = Math.round(startX + request.deltaX)
                val y = Math.round(startY + request.deltaY)
                if (x < root.bounds.left || x >= root.bounds.right || y < root.bounds.top || y >= root.bounds.bottom) throw NativeTargetFailure("swipe_endpoint_out_of_bounds")
                endX = x.toInt(); endY = y.toInt()
            }
            if (request.action != "longPress" && startX == endX && startY == endY) throw NativeTargetFailure("swipe_delta_zero")
            val hit = findActionViewAtPoint(root.root, startX, startY)
            val ownsPoint = if (request.action == "scroll") hit != null && targetContainsView(selected.view, hit)
                else nativePointerOwnsHit(selected.view, hit)
            if (!ownsPoint) throw NativeTargetFailure("native_target_obscured")
            return NativeGestureTarget(root.root, Rect(root.bounds), root.type, selected.selection.node.getJSONObject("targetRef"),
                startX.toFloat(), startY.toFloat(), endX.toFloat(), endY.toFloat()) {
                val current = windowRoots(owner).lastOrNull { it.root.isShown && it.root.alpha > 0f }
                activity() === owner && current != null && current.root === root.root && current.bounds == root.bounds &&
                    NativeWindowContract.pointerError(current.root.hasWindowFocus(), current.focusable,
                        current.touchable, current.focusOwnerWindowId) == null
            }
        }

        private fun foregroundActionWindow(activity: Activity): WindowRoot {
            val window = windowRoots(activity).lastOrNull { it.root.isShown && it.root.alpha > 0f }
                ?: throw NativeTargetFailure("native_window_unavailable")
            NativeWindowContract.pointerError(window.root.hasWindowFocus(), window.focusable, window.touchable, window.focusOwnerWindowId)
                ?.let { throw NativeTargetFailure(it) }
            return window
        }

        private fun targetContainsView(hit: View?, selected: View): Boolean {
            if (hit == null) return false
            var current: View? = selected
            while (current != null) {
                if (current === hit) return true
                current = current.parent as? View
            }
            return false
        }

        private fun nativePointerOwnsHit(selected: View, hit: View?): Boolean {
            if (targetContainsView(hit, selected)) return true
            // A semantic container can handle touches through its own passive
            // surface/UI layers. An interactive descendant or unrelated overlay
            // still requires its own selection; input retains its stricter rule.
            return hit != null && !hit.isClickable && !hit.isLongClickable && hit !is EditText &&
                targetContainsView(selected, hit)
        }

        private fun viewToJson(
            activity: Activity,
            view: View,
            counter: NodeCounter,
            depth: Int,
            parentEffectiveVisible: Boolean,
            windowId: String = viewIdentity(view.rootView),
            parentGuard: String = windowId,
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
                .put("editable", view is EditText && view.keyListener != null && view.isFocusable)
                .put("clickable", view.isClickable)
                .put("longClickable", view.isLongClickable)
                .put("focusable", view.isFocusable)
                .put("focused", view.isFocused)
                .put("selected", view.isSelected)
                .put("checked", (view as? Checkable)?.isChecked ?: JSONObject.NULL)
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
                json.put("text", if (isPasswordField(view)) "" else (view.text?.toString()?.take(300) ?: ""))
            }
            val viewId = viewIdentity(view)
            val targetRef = NativeTargetContract.reference(runtimeEpoch, windowId, viewId, parentGuard, json)
            json.put("targetRef", targetRef)
            counter.views[viewId] = view
            if (view is ViewGroup && depth < 24) {
                val children = JSONArray()
                for (index in 0 until view.childCount) {
                    children.put(viewToJson(activity, view.getChildAt(index), counter, depth + 1, effectiveVisible, windowId, targetRef.getString("guard")))
                }
                json.put("children", children)
            }
            return json
        }

        private fun viewIdentity(view: View): String {
            val key = R.id.aab_native_view_identity
            val existing = view.getTag(key)
            if (existing is String) return existing
            check(existing == null) { "Native View identity tag was overwritten" }
            return UUID.randomUUID().toString().also { view.setTag(key, it) }
        }

        private fun isPasswordField(view: View): Boolean {
            if (view !is EditText) {
                return false
            }
            if (view.transformationMethod is PasswordTransformationMethod) {
                return true
            }
            val inputType = view.inputType
            val klass = inputType and InputType.TYPE_MASK_CLASS
            val variation = inputType and InputType.TYPE_MASK_VARIATION
            return (klass == InputType.TYPE_CLASS_TEXT && variation in setOf(
                InputType.TYPE_TEXT_VARIATION_PASSWORD,
                InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD,
                InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
            )) || (klass == InputType.TYPE_CLASS_NUMBER && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD)
        }

        private fun findInputTextTarget(roots: List<WindowRoot>, x: Float, y: Float): TextInputTarget? {
            if (!x.isNaN() && !y.isNaN()) {
                val screenX = x.toInt()
                val screenY = y.toInt()
                val root = roots.asReversed().firstOrNull { it.root.isShown } ?: return null
                if (!root.bounds.contains(screenX, screenY)) return null
                // An explicit target must never turn into input on another field.
                return findEditTextAtPoint(root.root, screenX, screenY)?.let { TextInputTarget(root, it) }
            }
            val root = roots.asReversed().firstOrNull { it.root.isShown } ?: return null
            val view = findFocusedEditText(root.root)
            return view?.let { TextInputTarget(root, it) }
        }

        private fun findEditTextAtPoint(view: View, x: Int, y: Int): EditText? {
            if (!view.isShown || !view.isEnabled || view.alpha <= 0f || !boundsForView(view).contains(x, y)) return null
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

        private fun findActionViewAtPoint(view: View, x: Int, y: Int): View? {
            if (!view.isShown || view.alpha <= 0f || !boundsForView(view).contains(x, y)) {
                return null
            }
            var deepest: View? = null
            if (view is ViewGroup) {
                for (index in view.childCount - 1 downTo 0) {
                    val child = findActionViewAtPoint(view.getChildAt(index), x, y) ?: continue
                    if (child.isClickable || child.isLongClickable || child is EditText) {
                        return child
                    }
                    if (deepest == null) deepest = child
                }
            }
            if (view.isClickable || view.isLongClickable || view is EditText) return view
            return deepest ?: view
        }

        private fun actionViewToJson(activity: Activity, view: View): JSONObject {
            return JSONObject()
                .put("className", view.javaClass.name)
                .put("simpleClassName", view.javaClass.simpleName)
                .put("resourceName", resourceName(activity, view.id))
                .put("bounds", rectToJson(boundsForView(view)))
                .put("enabled", view.isEnabled)
                .put("clickable", view.isClickable)
                .put("longClickable", view.isLongClickable)
                .put("focusable", view.isFocusable)
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

        private fun isUsableEditText(view: EditText): Boolean {
            var ancestor: View? = view
            while (ancestor != null) {
                if (ancestor.alpha <= 0f) return false
                ancestor = ancestor.parent as? View
            }
            return view.isShown && view.isEnabled && view.isFocusable && view.keyListener != null &&
                view.width > 0 && view.height > 0
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
            val views = inspectWindowRoots()
            views.forEach { root ->
                if (!root.isAttachedToWindow || root.width <= 0 || root.height <= 0 || !seen.add(root)) {
                    return@forEach
                }
                val params = root.layoutParams as? android.view.WindowManager.LayoutParams
                    ?: throw NativeTargetFailure("native_window_metadata_unavailable")
                val ownerToken = root.applicationWindowToken
                val focusedOwner = views.singleOrNull { candidate ->
                    candidate.isAttachedToWindow && candidate.isShown && candidate.alpha > 0f && candidate.hasWindowFocus()
                        && ownerToken != null && candidate.applicationWindowToken == ownerToken
                }
                roots.add(
                    WindowRoot(
                        root = root,
                        bounds = boundsForView(root),
                        type = windowRootType(root, root === activityRoot),
                        activityDecor = root === activityRoot,
                        focusable = params.flags and android.view.WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE == 0,
                        touchable = params.flags and android.view.WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE == 0,
                        focusOwnerWindowId = focusedOwner?.let(::viewIdentity),
                    ),
                )
            }
            return roots
        }

        private fun inspectWindowRoots(): List<View> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return WindowInspector.getGlobalWindowViews()
            // Android 19-28 has no public window enumeration API. Failure must
            // remain visible; an Activity decor cannot stand in for a dialog.
            return try {
                val globalClass = Class.forName("android.view.WindowManagerGlobal")
                val instance = globalClass.getMethod("getInstance").invoke(null)
                val viewsField = globalClass.getDeclaredField("mViews")
                viewsField.isAccessible = true
                when (val rawViews = viewsField.get(instance)) {
                    is List<*> -> rawViews.filterIsInstance<View>()
                    is Array<*> -> rawViews.filterIsInstance<View>()
                    else -> throw NativeTargetFailure("native_window_enumeration_unavailable")
                }
            } catch (_: Throwable) {
                throw NativeTargetFailure("native_window_enumeration_unavailable")
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

        private fun writeJson(socket: LocalSocket, statusCode: Int, body: JSONObject) {
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
        val focusable: Boolean,
        val touchable: Boolean,
        val focusOwnerWindowId: String?,
    )

        private data class TextInputTarget(
        val root: WindowRoot,
        val view: EditText,
        )

        private data class ResolvedNativeTarget(val selection: NativeSelection, val root: WindowRoot, val view: View)

    private class NodeCounter {
        var count: Int = 0
        val views = mutableMapOf<String, View>()
    }

    private data class NativeViewSnapshot(val json: JSONObject, val roots: List<WindowRoot>, val views: Map<String, View>)
}
