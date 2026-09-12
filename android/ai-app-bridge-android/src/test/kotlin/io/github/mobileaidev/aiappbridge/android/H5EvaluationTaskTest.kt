package io.github.mobileaidev.aiappbridge.android

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class H5EvaluationTaskTest {
    private fun success() = JSONObject().put("ok", true).put("dispatched", true).put("ambiguous", false).put("result", "done")
    private class Queue {
        lateinit var task: Runnable
        fun post(value: Runnable): Boolean { task = value; return true }
        fun remove(value: Runnable) { }
    }
    private class Reply {
        val latch = CountDownLatch(1)
        val value = AtomicReference<JSONObject>()
        fun accept(result: JSONObject) { value.set(result); latch.countDown() }
        fun await(): JSONObject { assertTrue(latch.await(2, TimeUnit.SECONDS)); return value.get() }
    }
    private fun body(id: String = "original") = JSONObject().put("actionId", id).put("execution", JSONObject()
        .put("schemaVersion", ManagedActionProtocol.H5.schema).put("runtimeEpoch", "epoch").put("actionId", id).put("timeoutMs", 5000))
    private fun identity() = JSONObject().put("actionId", "original").put("runtimeEpoch", "epoch")

    @Test fun cancellationBeforeStartOrWhileQueuedPreventsLateEvaluation() {
        for (stopBeforeStart in listOf(false, true)) {
            val queue = Queue(); val reply = Reply(); var evaluations = 0
            val task = H5EvaluationTask(queue::post, queue::remove) { H5Evaluation { evaluations++; it(success()) } }
            if (stopBeforeStart) task.stop("h5_action_cancelled")
            task.start(reply::accept)
            if (!stopBeforeStart) { task.stop("h5_action_cancelled"); queue.task.run() }
            assertFalse(reply.await().getBoolean("dispatched")); assertEquals(0, evaluations)
        }
    }

    @Test fun cancellationDuringTargetPreparationPreventsSubmission() {
        val queue = Queue(); val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val reply = Reply(); var evaluations = 0
        val task = H5EvaluationTask(queue::post, queue::remove) {
            entered.countDown(); check(release.await(2, TimeUnit.SECONDS))
            H5Evaluation { evaluations++; it(success()) }
        }
        task.start(reply::accept); val worker = Thread { queue.task.run() }.apply { start() }
        assertTrue(entered.await(1, TimeUnit.SECONDS)); task.stop("h5_action_cancelled"); release.countDown(); worker.join(2000)
        assertFalse(reply.await().getBoolean("dispatched")); assertEquals(0, evaluations)
    }

    @Test fun unavailableMainQueueAndInvalidTargetAreExplicitNonDispatch() {
        val unavailable = Reply(); H5EvaluationTask({ false }, {}) { throw AssertionError("not prepared") }.start(unavailable::accept)
        assertEquals("main_thread_unavailable", unavailable.await().getString("error"))
        val queue = Queue(); val invalid = Reply()
        H5EvaluationTask(queue::post, queue::remove) { throw H5EvaluationFailure("no_webview") }.start(invalid::accept)
        queue.task.run(); assertEquals("no_webview", invalid.await().getString("error")); assertFalse(invalid.value.get().getBoolean("dispatched"))
    }

    @Test fun submittedEvaluationRetainsAdmissionUntilItsOriginalCallback() {
        val queue = Queue(); val original = Reply(); val cancelled = Reply()
        var completion: ((JSONObject) -> Unit)? = null
        val task = H5EvaluationTask(queue::post, queue::remove) { H5Evaluation { completion = it } }
        val executor = ManagedActionExecutor(ManagedActionProtocol.H5, "epoch", cleanupGraceMs = 20)
        executor.submit("eval", body(), { task }, original::accept); queue.task.run()
        executor.cancel(identity(), cancelled::accept)
        assertFalse(cancelled.await().getBoolean("settled")); assertTrue(executor.isBusy())
        assertFalse(original.await().getBoolean("settled"))
        val blocked = Reply(); executor.submit("eval", body("next"), { throw AssertionError("busy task was constructed") }, blocked::accept)
        assertEquals("h5_action_busy", blocked.await().getString("error"))
        completion!!(success()); assertFalse(executor.isBusy())
        val recovered = Reply(); executor.cancel(identity(), recovered::accept)
        val receipt = recovered.await().getJSONObject("executionResult")
        assertTrue(receipt.getBoolean("settled")); assertTrue(receipt.getBoolean("dispatched"))
        assertEquals("h5_action_cancelled", receipt.getString("error"))
    }

    @Test fun synchronousCallbackDoesNotReleaseBeforeTheJavaInvocationReturns() {
        val queue = Queue(); val reply = Reply(); val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val task = H5EvaluationTask(queue::post, queue::remove) { H5Evaluation {
            it(success()); entered.countDown(); check(release.await(2, TimeUnit.SECONDS))
        } }
        task.start(reply::accept); val worker = Thread { queue.task.run() }.apply { start() }
        assertTrue(entered.await(1, TimeUnit.SECONDS)); assertNull(reply.value.get())
        task.stop("h5_action_cancelled"); assertNull(reply.value.get()); release.countDown(); worker.join(2000)
        assertTrue(reply.await().getBoolean("dispatched"))
    }

    @Test fun thrownSubmissionCannotProveRendererCompletion() {
        val queue = Queue(); val reply = Reply(); var completion: ((JSONObject) -> Unit)? = null
        val task = H5EvaluationTask(queue::post, queue::remove) { H5Evaluation { completion = it; throw IllegalStateException("after possible submission") } }
        task.start(reply::accept); queue.task.run(); task.stop("h5_action_cancelled")
        assertNull(reply.value.get())
        completion!!(success()); val result = reply.await()
        assertEquals("h5_submission_failed", result.getString("error")); assertTrue(result.getBoolean("ambiguous"))
    }

    @Test fun nativeProtocolCannotBeUsedToAdmitAnH5Task() {
        val executor = ManagedActionExecutor(ManagedActionProtocol.H5, "epoch"); val reply = Reply()
        val request = body().apply { getJSONObject("execution").put("schemaVersion", ManagedActionProtocol.NATIVE.schema) }
        executor.submit("eval", request, { throw AssertionError("Wrong protocol admitted") }, reply::accept)
        assertEquals("invalid_h5_execution", reply.await().getString("error")); assertFalse(executor.isBusy())
    }

    @Test fun cancellationBetweenProbeAndMutationRemainsVisibleToTheOriginalTask() {
        val queue = Queue(); val reply = Reply(); var finishProbe: (() -> Unit)? = null; var mutations = 0
        val task = H5EvaluationTask(queue::post, queue::remove) { check -> H5Evaluation { complete ->
            finishProbe = {
                val reason = check()
                if (reason != null) complete(h5Failure(reason))
                else { mutations++; complete(success()) }
            }
        } }
        task.start(reply::accept); queue.task.run(); task.stop("h5_action_cancelled")
        assertNull(reply.value.get()); finishProbe!!()
        assertFalse(reply.await().getBoolean("dispatched")); assertEquals(0, mutations)
    }

    @Test fun invalidH5PayloadCannotAcquireAdmission() {
        val executor = ManagedActionExecutor(ManagedActionProtocol.H5, "epoch"); val reply = Reply()
        executor.submit("input", body(), { AndroidH5Bridge.validate(JSONObject().put("action", "input"));
            throw AssertionError("invalid payload admitted") }, reply::accept)
        assertEquals("invalid_h5_payload", reply.await().getString("error")); assertFalse(executor.isBusy())
    }
}
