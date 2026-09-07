package io.github.mobileaidev.aiappbridge.android.capture

import io.github.mobileaidev.aiappbridge.android.AiAppBridge
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidGetCutoverTest {
    @Test
    fun publicRecordThenFromHttpMatchesG0GetFields() {
        AiAppBridge.captureStore.clear()
        try {
            AiAppBridge.recordLog("info", "g3", "hello", null)
            AiAppBridge.recordNetwork("GET", "https://example.test/login", 200, 12L, null, null, null)
            AiAppBridge.recordState("app", "ready", "true")
            AiAppBridge.recordEvent("app", "opened", null)
            val logs = LegacyLiveView.fromHttp(AiAppBridge.captureStore, "logs", emptyMap(), 9)
            val state = LegacyLiveView.fromHttp(AiAppBridge.captureStore, "state", emptyMap(), 9)
            assertEquals(setOf("ok", "type", "items", "count", "sinceId", "sinceMs", "limit", "updatedAtMs"), logs.keys().asSequence().toSet())
            assertEquals("logs", logs.getString("type"))
            assertEquals(200, logs.getInt("limit"))
            assertEquals("hello", logs.getJSONArray("items").getJSONObject(0).getString("message"))
            assertFalse(logs.getJSONArray("items").getJSONObject(0).has("mobileFactId"))
            assertTrue(state.getJSONObject("values").has("app.ready"))
        } finally {
            AiAppBridge.captureStore.clear()
        }
    }

    @Test
    fun stateGetUsesStoreLruNotContainerInsertOrder() {
        AiAppBridge.captureStore.clear()
        try {
            for (id in 1..200) {
                AiAppBridge.recordState("app", "k$id", id.toString())
            }
            AiAppBridge.recordState("app", "k1", "999")
            AiAppBridge.recordState("app", "k201", "201")
            val live = LegacyLiveView.fromHttp(AiAppBridge.captureStore, "state", mapOf("limit" to "500"), 9)
            val values = live.getJSONObject("values")
            assertTrue(values.has("app.k1"))
            assertTrue(values.has("app.k201"))
            assertEquals(200, live.getInt("count"))
        } finally {
            AiAppBridge.captureStore.clear()
        }
    }

    @Test
    fun stateGetUsesStoreLruOnUpdateWithinTheWindow() {
        AiAppBridge.captureStore.clear()
        try {
            AiAppBridge.recordState("app", "a", "1")
            AiAppBridge.recordState("app", "b", "2")
            AiAppBridge.recordState("app", "a", "3")
            val live = LegacyLiveView.fromHttp(AiAppBridge.captureStore, "state", mapOf("limit" to "1"), 9)
            val values = live.getJSONObject("values")
            assertTrue(values.has("app.a"))
            assertEquals(3, values.get("app.a"))
            assertEquals(1, live.getInt("count"))
        } finally {
            AiAppBridge.captureStore.clear()
        }
    }
}
