package io.github.mobileaidev.aiappbridge.android.capture

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidShadowCaptureTest {
    @Test
    fun sanitizedEventsMatchLegacyLiveItemsAndValues() {
        val store = MobileCaptureStore()
        val oracleLogs = JSONArray()
        val oracleState = JSONArray()
        val oracleValues = JSONObject()
        val log = JSONObject()
            .put("id", 1L)
            .put("type", "log")
            .put("source", "http")
            .put("timestampMs", 1000L)
            .put("message", "hello")
        val state = JSONObject()
            .put("id", 2L)
            .put("type", "state")
            .put("source", "sdk")
            .put("timestampMs", 1001L)
            .put("namespace", "app")
            .put("key", "ready")
            .put("value", true)
        CaptureAppend.appendSanitized(store, log, "pkg", "epoch-1")
        CaptureAppend.appendSanitized(store, state, "pkg", "epoch-1")
        oracleLogs.put(JSONObject(log.toString()))
        oracleState.put(JSONObject(state.toString()))
        oracleValues.put("app.ready", true)

        val logs = LegacyLiveView.envelope(
            store.query(CaptureQuery(view = "legacy-live", stream = "logs", platform = "android")),
            CaptureQuery(view = "legacy-live", stream = "logs", platform = "android"),
            nowMs = 9,
        )
        val states = LegacyLiveView.envelope(
            store.query(CaptureQuery(view = "legacy-live", stream = "state", platform = "android")),
            CaptureQuery(view = "legacy-live", stream = "state", platform = "android"),
            nowMs = 9,
        )
        assertTrue(CaptureAppend.itemsMatch(oracleLogs, logs.getJSONArray("items")))
        assertTrue(CaptureAppend.itemsMatch(oracleState, states.getJSONArray("items")))
        assertTrue(CaptureAppend.valuesMatch(oracleValues, states.getJSONObject("values")))
        assertFalse(logs.getJSONArray("items").getJSONObject(0).has("mobileFactId"))
        assertEquals("app.ready", states.getJSONObject("values").keys().next())
    }
}
