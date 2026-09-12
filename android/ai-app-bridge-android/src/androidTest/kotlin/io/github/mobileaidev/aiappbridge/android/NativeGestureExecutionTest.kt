package io.github.mobileaidev.aiappbridge.android

import android.content.Intent
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.widget.LinearLayout
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestName
import java.io.File
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class NativeGestureExecutionTest {
    @get:Rule val testName = TestName()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val workers = Executors.newCachedThreadPool()
    private val traces = Collections.synchronizedList(mutableListOf<JSONObject>())
    private lateinit var activity: NativeGestureActivity
    private var epoch = ""
    private var socketName = ""

    @Before fun start() {
        activity = instrumentation.startActivitySync(Intent(instrumentation.targetContext, NativeGestureActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as NativeGestureActivity
        instrumentation.waitForIdleSync()
        socketName = JSONObject(File(activity.filesDir, "ai_app_bridge_endpoint.json").readText()).getString("socketName")
        epoch = request("/v1/status").getJSONObject("debugBridge").getString("runtimeEpoch")
        assertTrue(onUi { activity.window.decorView.hasWindowFocus() })
    }

    @After fun finish() {
        if (::activity.isInitialized) traces.add(onUi {
            JSONObject().put("kind", "independent-view-state").put("test", testName.methodName)
                .put("events", activity.button.events).put("longClicks", activity.longClicks)
                .put("scrollY", activity.scroll.scrollY).put("dialogShowing", activity.dialog?.isShowing == true)
        })
        val out = File(instrumentation.targetContext.filesDir, "native-gesture-tests").apply { mkdirs() }
        File(out, "${System.currentTimeMillis()}-${testName.methodName}.json").writeText(JSONArray(traces).toString(2))
        if (::activity.isInitialized) onUi { activity.dialog?.dismiss(); activity.finish() }
        workers.shutdownNow(); instrumentation.waitForIdleSync()
    }

    @Test fun longPressUsesRealTimeAndLetsTheAndroidLongClickCallbackRun() {
        val body = gesture("longPress", 700)
        var heartbeat = false
        onUi { Handler(Looper.getMainLooper()).postDelayed({ heartbeat = true }, 100) }
        val result = request("/v1/action/gesture-target", body)
        assertTrue(result.toString(), result.getBoolean("ok"))
        onUi { assertTrue(heartbeat); assertEquals(1, activity.longClicks) }
        assertEquals("completed", result.getString("completion"))
        val events = events(); assertEquals(listOf(0, 1), actions(events))
        assertTrue(events.last().getLong("eventTime") - events.first().getLong("eventTime") >= 700)
        assertTrue(events.all { it.getString("actionId") == body.getString("actionId") })
    }

    @Test fun swipeRecomputesItsStartAfterTheSameViewMoves() {
        val body = gesture("swipe", 240).put("deltaX", 120).put("deltaY", 0)
        val old = node("gesture-button").getJSONObject("bounds")
        onUi { activity.button.translationX = 30f }
        val result = request("/v1/action/gesture-target", body)
        assertTrue(result.toString(), result.getBoolean("ok"))
        assertEquals(old.getInt("left") + old.getInt("width") / 2 + 30, result.getInt("startX"))
        assertEquals(result.getInt("startX") + 120, result.getInt("endX"))
        val events = events(); assertEquals(0, events.first().getInt("action")); assertEquals(1, events.last().getInt("action"))
        assertTrue(events.any { it.getInt("action") == 2 })
        assertTrue(events.last().getLong("eventTime") - events.first().getLong("eventTime") >= 240)
    }

    @Test fun staleSemanticTargetAndOutOfWindowEndpointsNeverSendDown() {
        val stale = gesture("longPress", 500)
        onUi { activity.button.text = "Changed" }
        rejected(request("/v1/action/gesture-target", stale), "native_target_changed", false)
        val outOfWindow = gesture("swipe", 200).put("deltaX", 100000).put("deltaY", 0)
        rejected(request("/v1/action/gesture-target", outOfWindow), "swipe_endpoint_out_of_bounds", false)
        val roundedZero = gesture("swipe", 200).put("deltaX", 0.1).put("deltaY", 0.1)
        rejected(request("/v1/action/gesture-target", roundedZero), "swipe_delta_zero", false)
        assertEquals(0, events().size)
    }

    @Test fun replacingAnIdenticallyNamedViewRejectsTheObservedReference() {
        val body = gesture("longPress", 500)
        onUi { activity.root.removeView(activity.button); activity.button = activity.createButton(); activity.root.addView(activity.button, 0, LinearLayout.LayoutParams(-1, 400)) }
        instrumentation.waitForIdleSync()
        rejected(request("/v1/action/gesture-target", body), "native_target_replaced", false)
        assertEquals(0, events().size)
    }

    @Test fun scrollMovesOnlyTheExplicitSelectedContainer() {
        val body = gesture("scroll", 300, "gesture-scroll").put("direction", "down")
        val result = request("/v1/action/gesture-target", body)
        assertTrue(result.toString(), result.getBoolean("ok"))
        instrumentation.waitForIdleSync()
        assertTrue(onUi { activity.scroll.scrollY > 0 })
        assertEquals(0, events().size)
    }

    @Test fun scrollAtTheObservedBoundaryDoesNotInjectATouch() {
        val body = gesture("scroll", 300, "gesture-scroll").put("direction", "up")
        rejected(request("/v1/action/gesture-target", body), "native_scroll_boundary", false)
        assertEquals(0, onUi { activity.scroll.scrollY })
    }

    @Test fun windowChangeCancelsTheOriginalStreamAndDoesNotSendUp() {
        val body = gesture("longPress", 1500)
        onUi { activity.longClickHook = { activity.showDialog() } }
        val result = request("/v1/action/gesture-target", body)
        rejected(result, "native_gesture_window_changed", true)
        onUi { assertEquals(1, activity.longClicks); assertTrue(activity.dialog!!.isShowing) }
        assertEquals(listOf(0, 3), actions(events()))
    }

    @Test fun explicitCancellationSendsCancelBeforeASecondInputCanStart() {
        val body = gesture("longPress", 2000)
        val pressed = CountDownLatch(1)
        onUi { activity.button.hook = { if (it.actionMasked == 0) pressed.countDown() } }
        val response = workers.submit<JSONObject> { request("/v1/action/gesture-target", body) }
        assertTrue(pressed.await(2, TimeUnit.SECONDS))
        val tap = JSONObject().put("x", 100).put("y", 100)
        rejected(request("/v1/action/tap", tap), "native_action_busy", false)
        rejected(request("/v1/action/input-text", JSONObject().put("text", "blocked")), "native_action_busy", false)
        rejected(request("/v1/action/gesture-target", body), "native_action_busy", false)
        val cancel = request("/v1/action/cancel", cancellation(body)); assertTrue(cancel.toString(), cancel.getBoolean("ok"))
        rejected(response.get(3, TimeUnit.SECONDS), "native_action_cancelled", true)
        assertEquals(listOf(0, 3), actions(events())); assertEquals(0, onUi { activity.longClicks })
        assertTrue(request("/v1/action/tap", tap).getBoolean("ok"))
    }

    @Test fun cancellationWithAnotherRuntimeOrActionCannotStopTheActiveGesture() {
        val body = gesture("longPress", 650)
        val response = workers.submit<JSONObject> { request("/v1/action/gesture-target", body) }
        awaitActive(body.getString("actionId"))
        rejected(request("/v1/action/cancel", cancellation(body).put("runtimeEpoch", "another-runtime")), "native_action_not_active", false)
        rejected(request("/v1/action/cancel", cancellation(body).put("actionId", "another-action")), "native_action_not_active", false)
        assertTrue(response.get(3, TimeUnit.SECONDS).getBoolean("ok"))
        assertEquals(1, onUi { activity.longClicks })
    }

    @Test fun queuedCancellationNeverLeavesADelayedDown() {
        val body = gesture("longPress", 500)
        blockedMain {
            val response = workers.submit<JSONObject> { request("/v1/action/gesture-target", body) }
            awaitActive(body.getString("actionId"))
            assertTrue(request("/v1/action/cancel", cancellation(body)).getBoolean("ok"))
            rejected(response.get(2, TimeUnit.SECONDS), "native_action_cancelled", false)
        }
        assertEquals(0, events().size)
    }

    @Test fun queuedDeadlineNeverLeavesADelayedDown() {
        val body = gesture("swipe", 100).put("deltaX", 100).put("deltaY", 0).apply { getJSONObject("execution").put("timeoutMs", 200) }
        blockedMain { rejected(request("/v1/action/gesture-target", body), "native_action_timeout", false) }
        assertEquals(0, events().size)
    }

    @Test fun aBlockedTouchReportsUncertaintyAndKeepsOwnershipUntilCancelRuns() {
        val body = gesture("longPress", 500).apply { getJSONObject("execution").put("timeoutMs", 550) }
        val release = CountDownLatch(1)
        onUi { activity.button.hook = { if (it.actionMasked == 0) check(release.await(4, TimeUnit.SECONDS)) } }
        try {
            val result = request("/v1/action/gesture-target", body)
            assertEquals("native_action_timeout", result.getString("error")); assertTrue(result.isNull("dispatched")); assertTrue(result.getBoolean("ambiguous"))
            assertEquals(body.getString("actionId"), request("/v1/status").getJSONObject("debugBridge").getJSONObject("nativeAction").getString("actionId"))
            rejected(request("/v1/action/tap", JSONObject().put("x", 100).put("y", 100)), "native_action_busy", false)
        } finally { release.countDown() }
        instrumentation.waitForIdleSync()
        assertEquals(listOf(0, 3), actions(events())); assertEquals(0, onUi { activity.longClicks })
        assertTrue(request("/v1/status").getJSONObject("debugBridge").isNull("nativeAction"))
    }

    @Test fun invalidGestureJsonDoesNotStopTheSdkListener() {
        val result = rawRequest("/v1/action/gesture-target", "{")
        rejected(result, "invalid_json", false)
        rejected(rawRequest("/v1/action/cancel", "{"), "invalid_json", false)
        val missing = gesture("longPress", 500).apply { remove("actionId") }
        rejected(rawRequest("/v1/action/gesture-target", missing.toString()), "invalid_native_execution", false)
        assertTrue(request("/v1/status").getBoolean("ok")); assertEquals(0, events().size)
    }

    @Test fun captureFailureDoesNotSendAnotherTerminalTouchOrEraseTheDeliveryResult() {
        val body = gesture("longPress", 650)
        val executor = NativeGestureExecutor(Handler(Looper.getMainLooper()), { _, _ -> throw IllegalStateException("capture test fault") })
        val done = CountDownLatch(1)
        var result: JSONObject? = null
        executor.task(NativeGestureContract.parse(body), {
            val root = activity.window.decorView
            val rootBounds = Rect().apply { root.getGlobalVisibleRect(this) }
            val buttonBounds = Rect().apply { activity.button.getGlobalVisibleRect(this) }
            NativeGestureTarget(root, rootBounds, "activity", body.getJSONObject("targetRef"),
                buttonBounds.exactCenterX(), buttonBounds.exactCenterY(), buttonBounds.exactCenterX(), buttonBounds.exactCenterY()) { true }
        }).start { result = it; done.countDown() }
        assertTrue(done.await(3, TimeUnit.SECONDS))
        assertTrue(result.toString(), result!!.getBoolean("ok")); assertFalse(result!!.getBoolean("ambiguous"))
        assertEquals("java.lang.IllegalStateException", result!!.getString("evidenceError"))
        assertEquals(listOf(0, 1), actions(events())); assertEquals(1, onUi { activity.longClicks })
        traces.add(JSONObject().put("kind", "executor-capture-fault").put("response", result))
    }

    @Test fun idlePartialHttpRequestsCannotHoldTheListenerForever() {
        SdkTestHttp.connect(socketName).use { socket ->
            socket.getOutputStream().write("POST /v1/action/gesture-target HTTP/1.1\r\n".toByteArray())
            val start = SystemClock.uptimeMillis()
            assertTrue(request("/v1/status").getBoolean("ok"))
            assertTrue(SystemClock.uptimeMillis() - start < 3000)
        }
    }

    private fun gesture(action: String, duration: Int, label: String = "gesture-button") = managed(JSONObject()
        .put("action", action).put("actionId", "gesture-${System.nanoTime()}").put("durationMs", duration)
        .put("selector", JSONObject().put("contentDescription", label)).put("targetRef", node(label).getJSONObject("targetRef")), duration + 1500)
    private fun cancellation(body: JSONObject) = JSONObject().put("actionId", body.getString("actionId"))
        .put("runtimeEpoch", body.getJSONObject("targetRef").getString("runtimeEpoch"))
    private fun node(label: String): JSONObject {
        val tree = request("/v1/view/tree"); assertTrue(tree.toString(), tree.getBoolean("ok"))
        val matches = mutableListOf<JSONObject>()
        fun walk(node: JSONObject) { if (node.optBoolean("visible") && node.opt("contentDescription") == label) matches.add(node)
            val children = node.optJSONArray("children") ?: return; for (i in 0 until children.length()) walk(children.getJSONObject(i)) }
        val windows = tree.getJSONArray("windows"); walk(windows.getJSONObject(windows.length() - 1).getJSONObject("root"))
        assertEquals(1, matches.size); return matches.single()
    }
    private fun events(): List<JSONObject> = onUi { (0 until activity.button.events.length()).map { activity.button.events.getJSONObject(it) } }
    private fun actions(events: List<JSONObject>) = events.map { it.getInt("action") }
    private fun rejected(result: JSONObject, error: String, dispatched: Boolean) {
        assertFalse(result.toString(), result.getBoolean("ok")); assertEquals(result.toString(), error, result.getString("error"))
        assertEquals(dispatched, result.getBoolean("dispatched")); assertFalse(result.getBoolean("ambiguous"))
    }
    private fun awaitActive(actionId: String) {
        val deadline = SystemClock.uptimeMillis() + 2000
        while (request("/v1/status").getJSONObject("debugBridge").optJSONObject("nativeAction")?.opt("actionId") != actionId) {
            assertTrue("Gesture was not reserved", SystemClock.uptimeMillis() < deadline); Thread.sleep(10)
        }
    }
    private fun blockedMain(block: () -> Unit) {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        Handler(Looper.getMainLooper()).post { entered.countDown(); check(release.await(4, TimeUnit.SECONDS)) }
        assertTrue(entered.await(1, TimeUnit.SECONDS))
        try { block() } finally { release.countDown() }
        instrumentation.waitForIdleSync()
    }
    // The fixture speaks the current SDK wire contract explicitly.
    private fun managed(body: JSONObject, timeoutMs: Int = 1500): JSONObject {
        if (!body.has("actionId")) body.put("actionId", "native-test-${System.nanoTime()}")
        if (!body.has("execution")) body.put("execution", JSONObject().put("schemaVersion", ManagedActionProtocol.NATIVE.schema)
            .put("actionId", body.getString("actionId")).put("runtimeEpoch", epoch).put("timeoutMs", timeoutMs))
        return body
    }

    private fun request(path: String, body: JSONObject? = null): JSONObject {
        if (body != null && path.startsWith("/v1/action/") && path != "/v1/action/cancel") managed(body)
        return rawRequest(path, body?.toString())
    }
    private fun rawRequest(path: String, body: String?): JSONObject {
        val start = SystemClock.uptimeMillis()
        val result = SdkTestHttp.request(socketName, path, body, 6000)
        traces.add(JSONObject().put("path", path).put("body", body ?: JSONObject.NULL).put("response", result).put("elapsedMs", SystemClock.uptimeMillis() - start))
        return result
    }
    private fun <T> onUi(block: () -> T): T {
        var value: T? = null; instrumentation.runOnMainSync { value = block() }
        @Suppress("UNCHECKED_CAST") return value as T
    }
}
