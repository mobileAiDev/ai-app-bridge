package io.github.mobileaidev.aiappbridge.android.capture

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.ArrayDeque
import java.util.LinkedHashMap

class AndroidShadowContractTest {
    @Test
    fun fourStreamsAndFiltersMatchContainerOracle() {
        val shadow = ShadowSession()
        shadow.record("log", 1, 1_000, JSONObject().put("message", "a"))
        shadow.record("network", 2, 1_010, JSONObject().put("url", "https://example.test"))
        shadow.record("event", 3, 1_020, JSONObject().put("name", "opened"))
        shadow.record("state", 4, 1_030, JSONObject().put("namespace", "app").put("key", "ready").put("value", true))
        shadow.record("state", 5, 1_040, JSONObject().put("namespace", "app").put("key", "ready").put("value", false))
        shadow.assertLive("logs")
        shadow.assertLive("network")
        shadow.assertLive("events")
        shadow.assertLive("state")
        shadow.assertLive("logs", sinceId = 1, limit = 200)
        shadow.assertLive("logs", sinceMs = 1_000, limit = 1)
        assertEquals(false, shadow.stateValues().getBoolean("app.ready"))
    }

    @Test
    fun logOverflowAtContainerCapStillMatchesAtMaxGetLimit() {
        val shadow = ShadowSession()
        for (id in 1L..320L) {
            shadow.record("log", id, 1_000 + id, JSONObject().put("message", "m$id"))
        }
        assertEquals(300, shadow.containerSize("logs"))
        shadow.assertLive("logs", limit = 500)
        shadow.assertLive("logs", limit = 200)
        shadow.store.clear()
        shadow.logs.clear()
        shadow.assertLive("logs")
    }

    @Test
    fun stateInsertOrderEvictionDivergesFromStoreLruAfterUpdate() {
        val shadow = ShadowSession()
        for (id in 1L..200L) {
            shadow.record(
                "state",
                id,
                2_000 + id,
                JSONObject().put("namespace", "app").put("key", "k$id").put("value", id.toInt()),
            )
        }
        shadow.record(
            "state",
            201,
            2_300,
            JSONObject().put("namespace", "app").put("key", "k1").put("value", 999),
        )
        shadow.record(
            "state",
            202,
            2_301,
            JSONObject().put("namespace", "app").put("key", "k201").put("value", 201),
        )
        val live = shadow.live("state", limit = 500)
        assertFalse(CaptureAppend.itemsMatch(shadow.oracleItems("state", 500), live.getJSONArray("items")))
        assertTrue(shadow.oracleValues().has("app.k201"))
        assertFalse(shadow.oracleValues().has("app.k1"))
        assertTrue(live.getJSONObject("values").has("app.k1"))
        assertTrue(live.getJSONObject("values").has("app.k201"))
    }

    private class ShadowSession {
        val store = MobileCaptureStore(
            caps = CountCaps(logs = 300, network = 200, events = 300, state = 200),
        )
        val logs = ArrayDeque<JSONObject>()
        val network = ArrayDeque<JSONObject>()
        val events = ArrayDeque<JSONObject>()
        val state = LinkedHashMap<String, JSONObject>()

        fun record(type: String, id: Long, timestampMs: Long, extra: JSONObject) {
            val event = JSONObject(extra.toString())
                .put("id", id)
                .put("type", type)
                .put("source", "http")
                .put("timestampMs", timestampMs)
            when (type) {
                "log" -> appendBounded(logs, event, 300)
                "network" -> appendBounded(network, event, 200)
                "event" -> appendBounded(events, event, 300)
                "state" -> {
                    val key = "${event.getString("namespace")}.${event.getString("key")}"
                    if (!state.containsKey(key) && state.size >= 200) {
                        state.remove(state.keys.first())
                    }
                    state[key] = event
                }
                else -> throw IllegalArgumentException(type)
            }
            CaptureAppend.appendSanitized(store, event, "pkg", "epoch-1")
        }

        fun assertLive(stream: String, sinceId: Long? = null, sinceMs: Long? = null, limit: Int = 200) {
            val live = live(stream, sinceId, sinceMs, limit)
            assertTrue(CaptureAppend.itemsMatch(oracleItems(stream, limit, sinceId, sinceMs), live.getJSONArray("items")))
            if (stream == "state") {
                assertTrue(CaptureAppend.valuesMatch(oracleValues(sinceId, sinceMs, limit), live.getJSONObject("values")))
            }
            assertFalse(live.getJSONArray("items").let { items ->
                (0 until items.length()).any { items.getJSONObject(it).has("mobileFactId") }
            })
        }

        fun live(stream: String, sinceId: Long? = null, sinceMs: Long? = null, limit: Int = 200): JSONObject {
            val query = CaptureQuery(
                view = "legacy-live",
                stream = stream,
                sinceId = sinceId,
                sinceMs = sinceMs,
                limit = limit,
                platform = "android",
            )
            return LegacyLiveView.envelope(store.query(query), query, nowMs = 9)
        }

        fun containerSize(stream: String): Int = when (stream) {
            "logs" -> logs.size
            "network" -> network.size
            "events" -> events.size
            "state" -> state.size
            else -> 0
        }

        fun stateValues(): JSONObject = oracleValues()

        fun oracleItems(
            stream: String,
            limit: Int,
            sinceId: Long? = null,
            sinceMs: Long? = null,
        ): JSONArray {
            val filtered = source(stream).filter { matches(it, sinceId, sinceMs) }
            val limited = if (filtered.size > limit) filtered.takeLast(limit) else filtered
            val items = JSONArray()
            limited.forEach { items.put(JSONObject(it.toString())) }
            return items
        }

        fun oracleValues(sinceId: Long? = null, sinceMs: Long? = null, limit: Int = 200): JSONObject {
            val filtered = state.entries.filter { matches(it.value, sinceId, sinceMs) }
            val limited = if (filtered.size > limit) filtered.takeLast(limit) else filtered
            val values = JSONObject()
            limited.forEach { (key, event) -> values.put(key, event.opt("value")) }
            return values
        }

        private fun source(stream: String): List<JSONObject> = when (stream) {
            "logs" -> logs.toList()
            "network" -> network.toList()
            "events" -> events.toList()
            "state" -> state.values.toList()
            else -> emptyList()
        }

        private fun matches(event: JSONObject, sinceId: Long?, sinceMs: Long?): Boolean {
            if (sinceId != null && event.getLong("id") <= sinceId) return false
            if (sinceMs != null && event.getLong("timestampMs") < sinceMs) return false
            return true
        }

        private fun appendBounded(target: ArrayDeque<JSONObject>, event: JSONObject, cap: Int) {
            target.addLast(JSONObject(event.toString()))
            while (target.size > cap) {
                target.removeFirst()
            }
        }
    }
}
