package io.github.mobileaidev.aiappbridge.android

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class FlutterActivityAdmissionTest {
    private fun identity() = JSONObject().put("actionId", "original").put("runtimeEpoch", "A")
    private fun request() = JSONObject().put("action", "tap").put("actionId", "original")
        .put("execution", identity().put("schemaVersion", FlutterActionExecutor.SCHEMA).put("timeoutMs", 5000))
    private class Harness {
        val deliveries = mutableListOf<Pair<String, AiAppBridge.FlutterActionReply>>()
        val a = AiAppBridge.FlutterActionHandler { method, _, reply -> deliveries.add("A:$method" to reply) }
        val b = AiAppBridge.FlutterActionHandler { method, _, reply -> deliveries.add("B:$method" to reply) }
        var current: FlutterActionExecutor.Runtime? = FlutterActionExecutor.Runtime(a, "A", "A:1")
        val executor = FlutterActionExecutor(currentRuntime = { current })
    }

    @Test fun switchingActivitiesBeforeDartPermissionDeniesTheBackgroundEngineEvenWithTheSameEpoch() {
        val h = Harness(); var original: JSONObject? = null
        h.executor.submit(request()) { original = it }
        h.current = FlutterActionExecutor.Runtime(h.b, "A", "B:2")
        assertEquals("flutter_runtime_changed", h.executor.check(identity()).getString("error"))
        h.executor.cancel(identity()) { }
        assertFalse(original!!.getBoolean("dispatched"))
        assertEquals(listOf("A:executeAction", "A:cancelAction"), h.deliveries.map { it.first })
    }

    @Test fun returnToSameEngineDoesNotRevivePermissionFromAnEarlierForegroundGeneration() {
        val h = Harness()
        h.executor.submit(request()) { }
        h.current = FlutterActionExecutor.Runtime(h.a, "A", "A:3")
        assertFalse(h.executor.check(identity()).getBoolean("ok"))
        h.executor.cancel(identity()) { }
        assertFalse(h.executor.isBusy())
    }

    @Test fun grantedActionKeepsItsOriginalChannelAndCompletionWhenForegroundChanges() {
        val h = Harness(); var original: JSONObject? = null; var cancelled: JSONObject? = null
        h.executor.submit(request()) { original = it }
        assertTrue(h.executor.check(identity()).getBoolean("ok"))
        h.current = FlutterActionExecutor.Runtime(h.b, "B", "B:2")
        h.executor.cancel(identity()) { cancelled = it }
        assertNull(original); assertTrue(h.executor.isBusy())
        assertEquals(listOf("A:executeAction", "A:cancelAction"), h.deliveries.map { it.first })
        h.deliveries.first().second.reply(JSONObject().put("ok", true).put("dispatched", true).put("ambiguous", false)
            .put("execution", identity().put("schemaVersion", FlutterActionExecutor.SCHEMA).put("settled", true)).toString())
        assertTrue(original!!.getBoolean("settled")); assertTrue(original!!.getBoolean("dispatched"))
        assertEquals("A", cancelled!!.getJSONObject("executionResult").getString("runtimeEpoch"))
        var queried: JSONObject? = null; h.executor.query(identity()) { queried = it }
        assertEquals("original", queried!!.getString("actionId"))
        assertEquals(2, h.deliveries.size)
    }
}
