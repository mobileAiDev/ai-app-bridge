package io.github.mobileaidev.aiappbridge.android

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class NativeActionExecutorTest {
    private val epoch = "native-test-epoch"
    private fun request(id: String = "original", timeoutMs: Int = 5000) = JSONObject().put("actionId", id)
        .put("execution", JSONObject().put("schemaVersion", ManagedActionProtocol.NATIVE.schema).put("actionId", id)
            .put("runtimeEpoch", epoch).put("timeoutMs", timeoutMs))
    private fun identity(id: String = "original") = JSONObject().put("actionId", id).put("runtimeEpoch", epoch)
    private fun success() = JSONObject().put("ok", true).put("dispatched", true).put("ambiguous", false)
    private class Reply {
        val done = CountDownLatch(1)
        val value = AtomicReference<JSONObject>()
        val calls = AtomicInteger()
        fun accept(result: JSONObject) { value.set(result); calls.incrementAndGet(); done.countDown() }
        fun await(): JSONObject { assertTrue("Expected bounded reply", done.await(3, TimeUnit.SECONDS)); return value.get() }
    }
    private class Task : ManagedExecutionTask {
        var starts = 0
        val stopped = CountDownLatch(1)
        var reason: String? = null
        lateinit var complete: (JSONObject) -> Unit
        override fun start(complete: (JSONObject) -> Unit) { starts++; this.complete = complete }
        override fun stop(reason: String) { this.reason = reason; stopped.countDown() }
    }

    @Test fun completedActionHasAnImmutableIdentityBoundReceiptAndIsNeverReplayed() {
        val executor = ManagedActionExecutor(ManagedActionProtocol.NATIVE, epoch)
        val task = Task(); val reply = Reply()
        executor.submit("tap", request(), { task }, reply::accept)
        assertTrue(executor.isBusy()); task.complete(success())
        val result = reply.await()
        assertEquals("original", result.getJSONObject("execution").getString("actionId"))
        assertTrue(result.getBoolean("settled")); assertFalse(executor.isBusy())
        result.put("ok", false) // An HTTP caller cannot corrupt the retained receipt.
        val lookup = Reply(); executor.cancel(identity(), lookup::accept)
        assertTrue(lookup.await().getJSONObject("executionResult").getBoolean("ok"))
        val duplicate = Reply(); val unused = Task()
        executor.submit("input", request(), { unused }, duplicate::accept)
        assertEquals("native_action_id_reused", duplicate.await().getString("error")); assertEquals(0, unused.starts)
    }

    @Test fun cancellationKeepsAdmissionClosedUntilTheActualTaskFinishes() {
        val executor = ManagedActionExecutor(ManagedActionProtocol.NATIVE, epoch, cleanupGraceMs = 30)
        val task = Task(); val original = Reply(); val cancel = Reply()
        executor.submit("input", request(), { task }, original::accept)
        executor.cancel(identity(), cancel::accept)
        assertTrue(task.stopped.await(1, TimeUnit.SECONDS)); assertEquals("native_action_cancelled", task.reason)
        assertFalse(original.await().getBoolean("settled")); assertFalse(cancel.await().getBoolean("settled"))
        val next = Reply(); val untouched = Task()
        executor.submit("gesture", request("next"), { untouched }, next::accept)
        assertEquals("native_action_busy", next.await().getString("error")); assertEquals(0, untouched.starts)
        task.complete(success())
        val recovered = Reply(); executor.cancel(identity(), recovered::accept)
        val receipt = recovered.await().getJSONObject("executionResult")
        assertTrue(receipt.getBoolean("settled")); assertEquals("native_action_cancelled", receipt.getString("error"))
        assertTrue(receipt.getBoolean("dispatched")); assertFalse(executor.isBusy()); assertEquals(1, original.calls.get())
    }

    @Test fun aDeadlineRevokesTheTaskAndALateCompletionCanStillBeQueried() {
        val executor = ManagedActionExecutor(ManagedActionProtocol.NATIVE, epoch, cleanupGraceMs = 20)
        val task = Task(); val reply = Reply()
        executor.submit("tap", request(timeoutMs = 20), { task }, reply::accept)
        assertTrue(task.stopped.await(1, TimeUnit.SECONDS)); assertEquals("native_action_timeout", task.reason)
        assertTrue(reply.await().isNull("dispatched")); assertTrue(executor.isBusy())
        task.complete(success())
        val recovered = Reply(); executor.cancel(identity(), recovered::accept)
        assertEquals("native_action_timeout", recovered.await().getJSONObject("executionResult").getString("error"))
        assertFalse(executor.isBusy())
    }

    @Test fun aDifferentActionOrRuntimeCannotCancelOrProveTheOriginalOperation() {
        val executor = ManagedActionExecutor(ManagedActionProtocol.NATIVE, epoch)
        val task = Task(); executor.submit("tap", request(), { task }, {})
        for (identity in listOf(identity("another"), identity().put("runtimeEpoch", "another"))) {
            val reply = Reply(); executor.cancel(identity, reply::accept)
            assertEquals("native_action_not_active", reply.await().getString("error"))
        }
        assertNull(task.reason); assertTrue(executor.isBusy()); task.complete(success())
    }

    @Test fun executionAndCancellationSchemasRejectMissingCoercedAndUnknownFields() {
        val executor = ManagedActionExecutor(ManagedActionProtocol.NATIVE, epoch)
        val invalid = listOf(JSONObject(), request().apply { getJSONObject("execution").put("timeoutMs", "20") },
            request().apply { getJSONObject("execution").put("timeoutMs", 0) }, request().apply { getJSONObject("execution").put("timeoutMs", 1.5) },
            request().apply { getJSONObject("execution").put("extra", true) }, request().put("actionId", "different"),
            request().apply { getJSONObject("execution").put("schemaVersion", "old") })
        for (body in invalid) {
            val reply = Reply(); executor.submit("tap", body, { throw AssertionError("Invalid request constructed a task") }, reply::accept)
            assertEquals("invalid_native_execution", reply.await().getString("error"))
        }
        for (body in listOf(JSONObject(), identity().put("actionId", 1), identity().put("runtimeEpoch", ""), identity().put("force", true))) {
            val reply = Reply(); executor.cancel(body, reply::accept)
            assertEquals("invalid_native_execution_identity", reply.await().getString("error"))
        }
    }

    @Test fun staleExecutionAndTargetEpochsAreRejectedBeforeTaskConstruction() {
        val executor = ManagedActionExecutor(ManagedActionProtocol.NATIVE, epoch)
        for (body in listOf(request().apply { getJSONObject("execution").put("runtimeEpoch", "old") },
            request().put("targetRef", JSONObject().put("runtimeEpoch", "old")))) {
            val reply = Reply(); executor.submit("tap", body, { throw AssertionError("Stale target created a task") }, reply::accept)
            assertEquals("native_runtime_changed", reply.await().getString("error")); assertFalse(executor.isBusy())
        }
    }

    @Test fun malformedCompletionCannotReleaseOwnership() {
        val executor = ManagedActionExecutor(ManagedActionProtocol.NATIVE, epoch, cleanupGraceMs = 20)
        val task = Task(); val reply = Reply()
        executor.submit("tap", request(), { task }, reply::accept)
        task.complete(JSONObject().put("ok", true))
        assertEquals("invalid_native_execution_receipt", reply.await().getString("error")); assertTrue(executor.isBusy())
        task.complete(success()); assertFalse(executor.isBusy())
    }

    @Test fun captureFailureDoesNotEraseCompletionAndUnknownResultsStayDistinctFromSettlement() {
        val executor = ManagedActionExecutor(ManagedActionProtocol.NATIVE, epoch, settledEvent = { throw IllegalStateException("capture unavailable") })
        val task = Task(); val reply = Reply()
        executor.submit("tap", request(), { task }, reply::accept)
        task.complete(JSONObject().put("ok", false).put("error", "callback_failed").put("dispatched", true).put("ambiguous", true))
        val result = reply.await()
        assertTrue(result.getBoolean("settled")); assertTrue(result.getBoolean("ambiguous")); assertFalse(executor.isBusy())
        assertEquals("java.lang.IllegalStateException", result.getString("evidenceError"))
    }

    @Test fun anUnexpectedStartFailureDoesNotPretendTheTaskEnded() {
        val executor = ManagedActionExecutor(ManagedActionProtocol.NATIVE, epoch, cleanupGraceMs = 20)
        val reply = Reply()
        executor.submit("tap", request(), { object : ManagedExecutionTask {
            override fun start(complete: (JSONObject) -> Unit) { throw IllegalStateException("after possible scheduling") }
            override fun stop(reason: String) { }
        } }, reply::accept)
        assertEquals("native_task_start_failed", reply.await().getString("error")); assertTrue(executor.isBusy())
    }

    @Test fun mutationCheckPreventsAnotherWriteAfterCallbackCancellation() {
        for (alreadyDispatched in listOf(false, true)) {
            val gate = NativeMutationGate()
            if (alreadyDispatched) gate.dispatch()
            gate.stop("native_action_cancelled")
            try { gate.dispatch(); fail("A new mutation was admitted after cancellation") }
            catch (error: NativeTargetFailure) { assertEquals(alreadyDispatched, error.dispatched) }
        }
    }
}
