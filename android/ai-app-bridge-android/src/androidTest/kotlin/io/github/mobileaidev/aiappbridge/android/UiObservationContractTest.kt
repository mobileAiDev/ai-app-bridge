package io.github.mobileaidev.aiappbridge.android

import android.content.Intent
import android.widget.TextView
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class UiObservationContractTest {
    @Test fun embeddedH5ConsoleHookIsAbsentWhenIdleAndRemovedAfterExpiry() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val activity = instrumentation.startActivitySync(Intent(instrumentation.targetContext, H5FaultActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as H5FaultActivity
        fun evaluate(script: String): String {
            val done = java.util.concurrent.CountDownLatch(1)
            var value = ""
            instrumentation.runOnMainSync { activity.webView.evaluateJavascript(script) { value = it; done.countDown() } }
            assertTrue(done.await(5, java.util.concurrent.TimeUnit.SECONDS))
            return value
        }
        try {
            assertTrue(activity.ready.await(10, java.util.concurrent.TimeUnit.SECONDS))
            Thread.sleep(650)
            assertEquals("true", evaluate("window.originalConsole = console.log; typeof window.__aabConsoleHook === 'undefined'"))
            val socket = JSONObject(File(activity.filesDir, "ai_app_bridge_endpoint.json").readText()).getString("socketName")
            val opened = SdkTestHttp.request(socket, "/v1/ui/observation", """{"operation":"start","durationMs":1200}""", 6000)
            assertTrue(opened.toString(), opened.getBoolean("active"))
            Thread.sleep(200)
            assertEquals("true", evaluate("typeof window.__aabConsoleHook === 'object' && console.log !== window.originalConsole"))
            evaluate("console.log('bounded-h5-fixture')")
            Thread.sleep(1400)
            assertEquals("true", evaluate("typeof window.__aabConsoleHook === 'undefined' && console.log === window.originalConsole"))
        } finally {
            instrumentation.runOnMainSync { activity.webView.destroy(); activity.finish() }
        }
    }

    @Test fun flutterSnapshotIsPulledThroughTheRegisteredChannelOnlyOnRead() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val activity = instrumentation.startActivitySync(Intent(instrumentation.targetContext, UiObserverPerformanceActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as UiObserverPerformanceActivity
        val socket = JSONObject(File(activity.filesDir, "ai_app_bridge_endpoint.json").readText()).getString("socketName")
        val reads = java.util.concurrent.atomic.AtomicInteger(0)
        val handler = AiAppBridge.FlutterActionHandler { method, _, reply ->
            assertEquals("readSnapshot", method)
            val revision = reads.incrementAndGet()
            reply.reply(JSONObject().put("ok", true).put("snapshot", JSONObject().put("revision", revision)
                .put("layout", JSONObject().put("operable", JSONObject().put("runtimeEpoch", "test-flutter")))).toString())
        }
        try {
            AiAppBridge.setFlutterActionHandler(handler)
            Thread.sleep(1300)
            assertEquals(0, reads.get())
            repeat(2) { SdkTestHttp.request(socket, "/v1/status", null, 6000) }
            assertEquals("Status/heartbeat must not trigger a Flutter tree", 0, reads.get())
            repeat(2) { index ->
                val status = SdkTestHttp.request(socket, "/v1/flutter/snapshot", null, 6000)
                assertEquals(index + 1, status.getJSONObject("flutter").getInt("revision"))
            }
            Thread.sleep(1300)
            assertEquals(2, reads.get())
        } finally {
            AiAppBridge.clearFlutterActionHandler(handler)
            instrumentation.runOnMainSync { activity.finish() }
        }
    }

    @Test fun httpObservationIsOffByDefaultDetectsTextAndExpiresWithoutTheHost() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val activity = instrumentation.startActivitySync(Intent(instrumentation.targetContext, UiObserverPerformanceActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as UiObserverPerformanceActivity
        val socket = JSONObject(File(activity.filesDir, "ai_app_bridge_endpoint.json").readText()).getString("socketName")
        fun request(path: String, body: JSONObject? = null) = SdkTestHttp.request(socket, path, body?.toString(), 6000)
        fun status() = request("/v1/status").getJSONObject("uiObservation")
        try {
            instrumentation.runOnMainSync { activity.pulse.continuousRedraw = false }
            assertFalse(status().getBoolean("active"))
            val stoppedCount = status().getLong("sampleCount")
            Thread.sleep(650)
            assertEquals(stoppedCount, status().getLong("sampleCount"))
            val before = request("/v1/events?limit=1").getJSONArray("items")
            val since = if (before.length() > 0) before.getJSONObject(0).getLong("id") else 0
            val lease = request("/v1/ui/observation", JSONObject().put("operation", "start").put("durationMs", 1800))
            assertTrue(lease.toString(), lease.getBoolean("active"))
            assertEquals("ui_observation_busy", request("/v1/ui/observation", JSONObject().put("operation", "start").put("durationMs", 500)).getString("error"))
            assertFalse(request("/v1/ui/observation", JSONObject().put("operation", "stop").put("leaseId", "wrong-owner")).getBoolean("ok"))
            instrumentation.runOnMainSync { activity.findViewById<TextView>(android.R.id.text1).text = "21" }
            var semanticChanged = false
            repeat(12) {
                if (!semanticChanged) {
                    Thread.sleep(100)
                    val events = request("/v1/events?sinceId=$since&limit=100").getJSONArray("items")
                    semanticChanged = (0 until events.length()).any { index ->
                        val event = events.getJSONObject(index)
                        event.optString("name") == "ui.changed" && event.optJSONObject("data")?.optBoolean("semanticChanged") == true
                    }
                }
            }
            assertTrue("Explicit observation must see the real TextView change", semanticChanged)
            Thread.sleep(1900)
            assertFalse(status().getBoolean("active"))
            val expiredCount = status().getLong("sampleCount")
            instrumentation.runOnMainSync { activity.findViewById<TextView>(android.R.id.text1).text = "22" }
            Thread.sleep(600)
            assertEquals(expiredCount, status().getLong("sampleCount"))
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }
}
