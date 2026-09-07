package io.github.mobileaidev.aiappbridge.android.capture

import io.github.mobileaidev.aiappbridge.android.AiAppBridge
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class AiAppBridgeShadowWriteTest {
    @Test
    fun publicRecordApisWriteTheFourStreams() {
        AiAppBridge.captureStore.clear()
        try {
            AiAppBridge.recordLog("info", "g9", "hello", null)
            AiAppBridge.recordNetwork("GET", "https://example.test/login", 200, 12L, null, null, null)
            AiAppBridge.recordState("app", "ready", "true")
            AiAppBridge.recordEvent("app", "opened", null)

            val logs = live("logs")
            val network = live("network")
            val state = live("state")
            val events = live("events")
            assertEquals(1, logs.getJSONArray("items").length())
            assertEquals("hello", logs.getJSONArray("items").getJSONObject(0).getString("message"))
            assertEquals(200, network.getJSONArray("items").getJSONObject(0).getInt("statusCode"))
            assertTrue(state.getJSONObject("values").has("app.ready"))
            assertEquals("opened", events.getJSONArray("items").getJSONObject(0).getString("name"))
            assertFalse(logs.getJSONArray("items").getJSONObject(0).has("mobileFactId"))
        } finally {
            AiAppBridge.captureStore.clear()
        }
    }

    @Test
    fun productionHasNoContainersOrShadowDualWrite() {
        val source = File("src/main/kotlin/io/github/mobileaidev/aiappbridge/android/AiAppBridge.kt").readText()
        assertFalse(source.contains("logEntries"))
        assertFalse(source.contains("networkEntries"))
        assertFalse(source.contains("eventEntries"))
        assertFalse(source.contains("stateEntries"))
        assertFalse(source.contains("shadowCapture"))
        assertFalse(source.contains("AndroidShadowCapture"))
        assertFalse(source.contains("dualWrite"))
        assertFalse(source.contains("featureFlag"))
        assertFalse(source.contains("FactStoreReceiptPort"))
        assertFalse(source.contains("copyArray(logEntries"))
        assertFalse(source.contains("private fun buildCaptureResponse("))
        assertTrue(source.contains("CountCaps(logs = 300, network = 200, events = 300, state = 200)"))
        assertTrue(source.contains("LegacyLiveView.fromHttp(captureStore, \"logs\", query, System.currentTimeMillis())"))
        assertTrue(source.contains("LegacyLiveView.fromHttp(captureStore, \"network\", query, System.currentTimeMillis())"))
        assertTrue(source.contains("LegacyLiveView.fromHttp(captureStore, \"state\", query, System.currentTimeMillis())"))
        assertTrue(source.contains("LegacyLiveView.fromHttp(captureStore, \"events\", query, System.currentTimeMillis())"))
        val persistStart = source.indexOf("private fun persistCapturedLog(")
        val persistEnd = source.indexOf("private fun persistMobileFact(", persistStart)
        assertTrue(persistStart > 0 && persistEnd > persistStart)
        assertFalse(source.substring(persistStart, persistEnd).contains("CaptureAppend"))
        for (name in listOf("recordLogPayload", "recordNetworkPayload", "recordStatePayload", "recordEventPayload")) {
            val start = source.indexOf("private fun $name(")
            val end = source.indexOf("\n    private fun ", start + 1)
            assertTrue(name, start > 0 && end > start)
            val body = source.substring(start, end)
            assertFalse(name, body.contains("persistMobileFact(event)"))
            assertTrue(name, body.contains("CaptureAppend.appendSanitized("))
            assertFalse(name, body.contains("try {"))
        }
    }

    private fun live(stream: String) = LegacyLiveView.envelope(
        AiAppBridge.captureStore.query(
            CaptureQuery(view = "legacy-live", stream = stream, platform = "android"),
        ),
        CaptureQuery(view = "legacy-live", stream = stream, platform = "android"),
        nowMs = 9,
    )
}
