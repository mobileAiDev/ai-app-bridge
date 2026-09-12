package io.github.mobileaidev.aiappbridge.android

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class FlutterActionExecutorTest {
    private class Response {
        private val latch = CountDownLatch(1)
        private val value = AtomicReference<JSONObject>()
        fun reply(body: JSONObject) { value.set(body); latch.countDown() }
        fun await(): JSONObject { assertTrue("response did not settle", latch.await(2, TimeUnit.SECONDS)); return value.get() }
        fun ready() = latch.count == 0L
    }
    private class Peer(grace: Long = 30) {
        var epoch = "runtime-A"
        val calls = CopyOnWriteArrayList<Pair<String, AiAppBridge.FlutterActionReply>>()
        val executor = FlutterActionExecutor({ AiAppBridge.FlutterActionHandler { method, _, reply -> calls.add(method to reply) } }, { epoch }, grace)
        fun identity(id: String = "action-A") = JSONObject().put("actionId", id).put("runtimeEpoch", epoch)
        fun body(id: String = "action-A", timeout: Long = 5000) = JSONObject().put("action", "back").put("actionId", id)
            .put("execution", identity(id).put("schemaVersion", FlutterActionExecutor.SCHEMA).put("timeoutMs", timeout))
        fun submit(id: String = "action-A", timeout: Long = 5000) = Response().also { executor.submit(body(id, timeout), it::reply) }
        fun cancel(id: String = "action-A") = Response().also { executor.cancel(identity(id), it::reply) }
        fun finish(id: String = "action-A", dispatched: Boolean = true, error: String? = null, index: Int = 0) {
            val receipt = JSONObject().put("ok", error == null).put("dispatched", dispatched).put("ambiguous", false)
                .put("execution", identity(id).put("schemaVersion", FlutterActionExecutor.SCHEMA).put("settled", true))
            if (error != null) receipt.put("error", error)
            calls.filter { it.first == "executeAction" }[index].second.reply(receipt.toString())
        }
    }

    @Test fun queuedCancellationRevokesAllFuturePermission() {
        val p = Peer(); val original = p.submit(); val cancel = p.cancel().await()
        assertFalse(original.await().getBoolean("dispatched"))
        assertFalse(cancel.getJSONObject("executionResult").getBoolean("ambiguous"))
        assertFalse(p.executor.check(p.identity()).getBoolean("ok"))
        assertFalse(p.executor.isBusy())
        assertEquals("cancelAction", p.calls.last().first)
        assertEquals("flutter_action_id_reused", p.submit().await().getString("error"))
        val next = p.submit("action-B")
        assertFalse(p.executor.check(p.identity()).getBoolean("ok"))
        assertTrue(p.executor.check(p.identity("action-B")).getBoolean("ok"))
        p.finish("action-B", index = 1); assertTrue(next.await().getBoolean("ok"))
    }

    @Test fun queuedDeadlineSettlesWithoutWaitingForDart() {
        val p = Peer(); val result = p.submit(timeout = 20).await()
        assertEquals("flutter_action_timeout", result.getString("error"))
        assertFalse(result.getBoolean("dispatched")); assertTrue(result.getBoolean("settled"))
        assertFalse(p.executor.check(p.identity()).getBoolean("ok"))
    }

    @Test fun grantedCancellationWaitsForOriginalExecutionNotTheCancelSignalReply() {
        val p = Peer(500); val original = p.submit()
        assertTrue(p.executor.check(p.identity()).getBoolean("ok"))
        val cancellation = p.cancel()
        p.calls.last().second.reply("{\"ok\":true}")
        assertFalse(cancellation.ready()); assertFalse(original.ready()); assertTrue(p.executor.isBusy())
        assertEquals("flutter_action_busy", p.submit("action-B").await().getString("error"))
        assertFalse(p.executor.check(p.identity()).getBoolean("ok"))
        p.finish(error = "flutter_action_cancelled")
        assertTrue(cancellation.await().getJSONObject("executionResult").getBoolean("dispatched"))
        assertTrue(original.await().getBoolean("settled")); assertFalse(p.executor.isBusy())
    }

    @Test fun blockedDartReturnsUnknownAndRetainsAdmissionUntilLateCompletion() {
        val p = Peer(); val original = p.submit()
        p.executor.check(p.identity())
        val cancel = p.cancel().await()
        assertEquals("flutter_action_cancel_pending", cancel.getString("error"))
        assertTrue(cancel.getBoolean("ambiguous")); assertTrue(cancel.isNull("dispatched"))
        assertFalse(original.await().getBoolean("settled")); assertTrue(p.executor.isBusy())
        assertFalse(p.cancel().await().getBoolean("settled"))
        p.finish(error = "flutter_action_cancelled")
        assertFalse(p.executor.isBusy())
        assertTrue(p.cancel().await().getJSONObject("executionResult").getBoolean("settled"))
    }

    @Test fun malformedGrantedReceiptCannotReleaseAdmission() {
        val p = Peer(); val original = p.submit(); p.executor.check(p.identity())
        p.calls.first().second.reply("{\"ok\":true}")
        assertEquals("invalid_flutter_execution_receipt", original.await().getString("error"))
        assertTrue(p.executor.isBusy()); assertFalse(p.executor.check(p.identity()).getBoolean("ok"))
        p.finish(error = "flutter_action_cancelled"); assertFalse(p.executor.isBusy())
    }

    @Test fun wrongIdentityCannotRevokeActiveExecution() {
        val p = Peer(); val original = p.submit(); p.executor.check(p.identity())
        assertEquals("flutter_action_not_active", p.cancel("action-B").await().getString("error"))
        val wrong = Response()
        p.executor.cancel(p.identity().put("runtimeEpoch", "other"), wrong::reply)
        assertFalse(wrong.await().getBoolean("ok")); assertTrue(p.executor.check(p.identity()).getBoolean("ok"))
        p.finish(); assertTrue(original.await().getBoolean("ok"))
    }

    @Test fun retainedCompletionCannotCancelANewerOperation() {
        val p = Peer(); val original = p.submit(); p.executor.check(p.identity()); p.finish()
        assertTrue(original.await().getBoolean("ok"))
        val next = p.submit("action-B")
        assertTrue(p.cancel().await().getJSONObject("executionResult").getBoolean("ok"))
        assertTrue(p.executor.check(p.identity("action-B")).getBoolean("ok"))
        p.finish("action-B", index = 1); assertTrue(next.await().getBoolean("ok"))
    }

    @Test fun strictAdmissionRejectsMissingSchemaExtraFieldsAndChangedRuntime() {
        val p = Peer()
        for (body in listOf(JSONObject().put("action", "back"), p.body().put("actionId", "wrong"),
            p.body().apply { getJSONObject("execution").put("timeoutMs", "100") },
            p.body().apply { getJSONObject("execution").put("extra", true) })) {
            val result = Response(); p.executor.submit(body, result::reply)
            assertEquals("invalid_flutter_execution", result.await().getString("error"))
        }
        val old = p.body(); p.epoch = "runtime-B"
        val result = Response(); p.executor.submit(old, result::reply)
        assertEquals("flutter_runtime_changed", result.await().getString("error")); assertTrue(p.calls.isEmpty())
    }

    @Test fun aThrowingChannelStillRevokesItsQueuedDelivery() {
        val executor = FlutterActionExecutor({ AiAppBridge.FlutterActionHandler { _, _, _ -> error("channel failed") } }, { "runtime-A" })
        val result = Response(); executor.submit(Peer().body(), result::reply)
        assertEquals("flutter_channel_failed", result.await().getString("error"))
        assertFalse(result.await().getBoolean("dispatched")); assertFalse(executor.isBusy())
    }
}
