package io.github.mobileaidev.aiappbridge.android

import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
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
import java.util.concurrent.atomic.AtomicReference

// Real SDK HTTP admission and Android UI faults; the channel peer is controlled.
// Actual Dart pointer/editor behavior is tested separately, never inferred here.
class FlutterExecutionFaultTest {
    @get:Rule val testName = TestName()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val workers = Executors.newCachedThreadPool()
    private val traces = Collections.synchronizedList(mutableListOf<JSONObject>())
    private lateinit var activity: NativeFaultActivity
    private var socketName = ""
    private val epoch = "flutter-fault-${System.nanoTime()}"
    private val actionId = "action-${System.nanoTime()}"

    @Before fun start() {
        activity = instrumentation.startActivitySync(Intent(instrumentation.targetContext, NativeFaultActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as NativeFaultActivity
        instrumentation.waitForIdleSync()
        socketName = JSONObject(File(activity.filesDir, "ai_app_bridge_endpoint.json").readText()).getString("socketName")
        AiAppBridge.updateFlutterSnapshot(JSONObject().put("layout", JSONObject().put("operable", JSONObject()
            .put("runtimeEpoch", epoch).put("executionSchema", FlutterActionExecutor.SCHEMA))).toString())
    }

    @After fun finish() {
        val value = onUi { activity.editor.text.toString() }
        traces.add(JSONObject().put("kind", "independent-editor-state").put("text", value))
        val out = File(instrumentation.targetContext.filesDir, "flutter-execution-tests").apply { mkdirs() }
        File(out, "${System.currentTimeMillis()}-${testName.methodName}.json").writeText(JSONArray(traces).toString(2))
        AiAppBridge.setFlutterActionHandler(null); AiAppBridge.updateFlutterSnapshot("{}")
        onUi { activity.finish() }; workers.shutdownNow(); instrumentation.waitForIdleSync()
    }

    @Test fun queuedCancelReturnsWhileMainIsBlockedAndCannotWriteWhenItResumes() {
        val queued = installQueuedPeer()
        blockedMain {
            val original = workers.submit<JSONObject> { request("/v1/flutter/action", body()) }
            assertTrue(queued.await(2, TimeUnit.SECONDS))
            val start = SystemClock.uptimeMillis()
            val cancellation = request("/v1/flutter/cancel", identity())
            assertTrue("cancel waited for blocked main", SystemClock.uptimeMillis() - start < 1000)
            assertTrue(cancellation.getBoolean("ok"))
            val result = original.get(2, TimeUnit.SECONDS)
            assertEquals("flutter_action_cancelled", result.getString("error"))
            assertFalse(result.getBoolean("dispatched")); assertFalse(result.getBoolean("ambiguous"))
        }
        assertEquals("initial", onUi { activity.editor.text.toString() })
    }

    @Test fun queuedDeadlineRevokesDeliveryWithoutAHostCancel() {
        installQueuedPeer()
        blockedMain {
            val result = request("/v1/flutter/action", body(150))
            assertEquals("flutter_action_timeout", result.getString("error"))
            assertFalse(result.getBoolean("dispatched")); assertTrue(result.getBoolean("settled"))
        }
        assertEquals("initial", onUi { activity.editor.text.toString() })
    }

    @Test fun grantedButUnresponsivePeerKeepsNativeInputBlockedUntilOriginalCompletion() {
        val entered = CountDownLatch(1)
        val originalReply = AtomicReference<AiAppBridge.FlutterActionReply>()
        AiAppBridge.setFlutterActionHandler { method, _, reply ->
            if (method == "executeAction") {
                originalReply.set(reply)
                Handler(Looper.getMainLooper()).post {
                    assertTrue(JSONObject(AiAppBridge.checkFlutterAction(identity().toString())).getBoolean("ok"))
                    activity.editor.setText("first effect")
                    entered.countDown()
                }
            } else reply.reply("{\"ok\":true}") // Signal receipt is not completion.
        }
        val original = workers.submit<JSONObject> { request("/v1/flutter/action", body()) }
        assertTrue(entered.await(2, TimeUnit.SECONDS))
        try {
            val cancellation = request("/v1/flutter/cancel", identity())
            assertFalse(cancellation.getBoolean("ok")); assertFalse(cancellation.getBoolean("settled"))
            assertTrue(cancellation.getBoolean("ambiguous"))
            assertFalse(original.get(2, TimeUnit.SECONDS).getBoolean("settled"))
            val blocked = request("/v1/action/input-text", JSONObject().put("text", "must not replace"))
            assertEquals("flutter_action_busy", blocked.getString("error"))
            assertEquals("first effect", onUi { activity.editor.text.toString() })
            assertFalse(JSONObject(AiAppBridge.checkFlutterAction(identity().toString())).getBoolean("ok"))
        } finally { originalReply.get()?.reply(receipt(true).toString()) }
        assertTrue(request("/v1/flutter/cancel", identity()).getJSONObject("executionResult").getBoolean("settled"))
        assertTrue(request("/v1/status").getJSONObject("debugBridge").isNull("flutterAction"))
    }

    @Test fun invalidExecutionDoesNotBreakTheListenerOrReachTheChannel() {
        var reached = false
        AiAppBridge.setFlutterActionHandler { _, _, _ -> reached = true }
        val invalid = body().apply { getJSONObject("execution").put("timeoutMs", "100") }
        assertEquals("invalid_flutter_execution", request("/v1/flutter/action", invalid).getString("error"))
        assertFalse(reached)
        assertTrue(request("/v1/status").getBoolean("ok"))
        assertEquals("initial", onUi { activity.editor.text.toString() })
    }

    @Test fun lateOldEngineDetachCannotRemoveTheNewExecutionHandler() {
        val old = AiAppBridge.FlutterActionHandler { _, _, _ -> fail("old engine must not execute") }
        val current = AiAppBridge.FlutterActionHandler { method, _, reply ->
            if (method == "executeAction") reply.reply(receipt(false).toString())
        }
        AiAppBridge.setFlutterActionHandler(old)
        AiAppBridge.setFlutterActionHandler(current)
        assertFalse(AiAppBridge.clearFlutterActionHandler(old))
        val result = request("/v1/flutter/action", body())
        assertTrue(result.getBoolean("settled"))
        assertEquals(actionId, result.getString("actionId"))
        assertTrue(AiAppBridge.clearFlutterActionHandler(current))
        assertEquals("flutter_action_handler_absent", request("/v1/flutter/action", body()).getString("error"))
    }

    private fun installQueuedPeer(): CountDownLatch {
        val queued = CountDownLatch(1)
        AiAppBridge.setFlutterActionHandler { method, _, reply ->
            if (method == "executeAction") {
                Handler(Looper.getMainLooper()).post {
                    val admitted = JSONObject(AiAppBridge.checkFlutterAction(identity().toString())).getBoolean("ok")
                    if (admitted) activity.editor.setText("late write")
                    traces.add(JSONObject().put("kind", "late-channel-admission").put("admitted", admitted))
                    reply.reply(receipt(admitted).toString())
                }
                queued.countDown()
            } else reply.reply("{\"ok\":true}")
        }
        return queued
    }
    private fun identity() = JSONObject().put("actionId", actionId).put("runtimeEpoch", epoch)
    private fun body(timeout: Int = 10000) = JSONObject().put("action", "back").put("actionId", actionId)
        .put("execution", identity().put("schemaVersion", FlutterActionExecutor.SCHEMA).put("timeoutMs", timeout))
    private fun receipt(dispatched: Boolean) = JSONObject().put("ok", false).put("error", "flutter_action_cancelled")
        .put("dispatched", dispatched).put("ambiguous", false).put("execution", identity()
            .put("schemaVersion", FlutterActionExecutor.SCHEMA).put("settled", true))
    private fun blockedMain(block: () -> Unit) {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        Handler(Looper.getMainLooper()).post { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
        assertTrue(entered.await(1, TimeUnit.SECONDS))
        try { block() } finally { release.countDown() }
        instrumentation.waitForIdleSync()
    }
    private fun request(path: String, body: JSONObject? = null): JSONObject {
        val start = SystemClock.uptimeMillis()
        val response = SdkTestHttp.request(socketName, path, body?.toString(), 4000)
        traces.add(JSONObject().put("path", path).put("body", body ?: JSONObject.NULL)
            .put("response", response).put("elapsedMs", SystemClock.uptimeMillis() - start))
        return response
    }
    private fun <T> onUi(block: () -> T): T {
        var value: T? = null; instrumentation.runOnMainSync { value = block() }
        @Suppress("UNCHECKED_CAST") return value as T
    }
}
