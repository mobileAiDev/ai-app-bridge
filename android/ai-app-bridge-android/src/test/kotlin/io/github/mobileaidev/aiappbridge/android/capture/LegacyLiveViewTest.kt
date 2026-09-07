package io.github.mobileaidev.aiappbridge.android.capture

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LegacyLiveViewTest {
    @Test
    fun envelopeMatchesG0GetFieldsAndDoesNotLeakFactIds() {
        val store = MobileCaptureStore()
        store.append(
            CaptureInput(
                stream = "logs",
                targetKey = "android:[\"s\",\"com.example\"]",
                runtimeEpoch = "epoch-1",
                captureId = 7,
                timestampMs = 1000,
                record = JSONObject().put("id", 7).put("message", "hello"),
            ),
        )
        val query = CaptureQuery(view = "legacy-live", stream = "logs", limit = 200, platform = "android")
        val page = store.query(query)
        val body = LegacyLiveView.envelope(page, query, nowMs = 9)
        assertEquals(true, body.getBoolean("ok"))
        assertEquals("logs", body.getString("type"))
        assertEquals(1, body.getInt("count"))
        assertEquals(200, body.getInt("limit"))
        assertEquals(9, body.getLong("updatedAtMs"))
        assertTrue(body.isNull("sinceId"))
        assertTrue(body.isNull("sinceMs"))
        val keys = body.keys().asSequence().toSet()
        assertEquals(
            setOf("ok", "type", "items", "count", "sinceId", "sinceMs", "limit", "updatedAtMs"),
            keys,
        )
        val item = body.getJSONArray("items").getJSONObject(0)
        assertEquals(7, item.getLong("id"))
        assertFalse(item.has("mobileFactId"))
        assertEquals(500, LegacyLiveView.resolveLimit(query.copy(limit = 9_999)))
        assertEquals(1_000, LegacyLiveView.resolveLimit(query.copy(limit = 9_999, platform = "ios")))
    }

    @Test
    fun fromHttpClampsLimitAndKeepsG0Fields() {
        val store = MobileCaptureStore()
        store.append(
            CaptureInput(
                stream = "logs",
                targetKey = "android:[\"s\",\"com.example\"]",
                runtimeEpoch = "epoch-1",
                captureId = 3,
                timestampMs = 2000,
                record = JSONObject().put("id", 3).put("message", "http"),
            ),
        )
        val body = LegacyLiveView.fromHttp(
            store,
            "logs",
            mapOf("limit" to "9999", "sinceId" to "0"),
            nowMs = 11,
        )
        assertEquals(true, body.getBoolean("ok"))
        assertEquals("logs", body.getString("type"))
        assertEquals(1, body.getInt("count"))
        assertEquals(500, body.getInt("limit"))
        assertEquals(0, body.getLong("sinceId"))
        assertEquals(11, body.getLong("updatedAtMs"))
        assertEquals("http", body.getJSONArray("items").getJSONObject(0).getString("message"))
        assertFalse(body.getJSONArray("items").getJSONObject(0).has("mobileFactId"))
    }
}
