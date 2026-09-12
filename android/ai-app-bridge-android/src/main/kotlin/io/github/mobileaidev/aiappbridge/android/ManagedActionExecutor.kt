package io.github.mobileaidev.aiappbridge.android

import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

internal interface ManagedExecutionTask {
    // Construction is inert. A stop before start must prevent any later dispatch.
    fun start(complete: (JSONObject) -> Unit)
    fun stop(reason: String)
}

// Each protocol coordinator owns its admitted tasks. HTTP expiry only stops waiting;
// admission remains closed until the actual UI task has returned and cleaned up.
internal enum class ManagedActionProtocol(val prefix: String, val schema: String) {
    NATIVE("native", "aab.native-execution/v1"),
    H5("h5", "aab.h5-execution/v1"),
}

internal class ManagedActionExecutor(
    private val protocol: ManagedActionProtocol,
    private val runtimeEpoch: String,
    private val cleanupGraceMs: Long = 1500,
    private val settledEvent: (JSONObject) -> Unit = {},
) {
    private val lock = Any()
    private val timers = Executors.newSingleThreadScheduledExecutor { task ->
        Thread(task, "aab-${protocol.prefix}-lifetime").apply { isDaemon = true }
    }
    private var active: Operation? = null
    private var lastResult: JSONObject? = null

    fun isBusy(): Boolean = synchronized(lock) { active != null }
    fun status(): JSONObject? = synchronized(lock) {
        active?.let { identity(it).put("kind", it.kind).put("settled", false).put("stopReason", it.stopReason ?: JSONObject.NULL) }
    }

    fun submit(kind: String, body: JSONObject, createTask: () -> ManagedExecutionTask, reply: (JSONObject) -> Unit) {
        val execution = body.optJSONObject("execution")
        if (execution == null || execution.keys().asSequence().toSet() != setOf("schemaVersion", "actionId", "runtimeEpoch", "timeoutMs") ||
            execution.opt("schemaVersion") != protocol.schema || !nonempty(execution.opt("actionId")) ||
            !nonempty(execution.opt("runtimeEpoch")) || !integerMs(execution.opt("timeoutMs")) || body.opt("actionId") != execution.opt("actionId")) {
            reply(failure("invalid_${protocol.prefix}_execution")); return
        }
        if (execution.opt("runtimeEpoch") != runtimeEpoch || body.has("targetRef") && body.optJSONObject("targetRef")?.opt("runtimeEpoch") != runtimeEpoch) {
            reply(failure("${protocol.prefix}_runtime_changed")); return
        }
        val op: Operation
        synchronized(lock) {
            if (active != null) { reply(failure("${protocol.prefix}_action_busy")); return }
            if (lastResult?.opt("actionId") == execution.opt("actionId")) { reply(failure("${protocol.prefix}_action_id_reused")); return }
            val task = try { createTask() }
            catch (error: NativeTargetFailure) { reply(error.response()); return }
            catch (error: H5EvaluationFailure) { reply(error.response()); return }
            catch (_: org.json.JSONException) { reply(failure("invalid_json")); return }
            op = Operation(kind, execution.getString("actionId"), task, reply)
            active = op
            op.timeout = timers.schedule({ stop(op, "${protocol.prefix}_action_timeout") }, execution.getLong("timeoutMs"), TimeUnit.MILLISECONDS)
        }
        try { op.task.start { result -> complete(op, result) } }
        catch (_: Throwable) { stop(op, "${protocol.prefix}_task_start_failed") }
    }

    fun cancel(body: JSONObject, reply: (JSONObject) -> Unit) {
        if (!validIdentity(body)) { reply(failure("invalid_${protocol.prefix}_execution_identity")); return }
        val op = synchronized(lock) {
            lastResult?.takeIf { it.opt("actionId") == body.opt("actionId") && it.opt("runtimeEpoch") == body.opt("runtimeEpoch") }
                ?.let { reply(cancelReceipt(it)); return }
            val current = active
            if (current == null || current.actionId != body.opt("actionId") || body.opt("runtimeEpoch") != runtimeEpoch) {
                reply(failure("${protocol.prefix}_action_not_active")); return
            }
            if (current.cancelReply != null || current.cleanupExpired) { reply(pending(current, "${protocol.prefix}_action_cancel_pending")); return }
            current.cancelReply = reply
            current
        }
        stop(op, "${protocol.prefix}_action_cancelled")
    }

    private fun stop(op: Operation, reason: String) {
        synchronized(lock) {
            if (active !== op || op.stopReason != null) return
            op.stopReason = reason
            op.cleanup = timers.schedule({
                synchronized(lock) {
                    if (active !== op) return@schedule
                    op.cleanupExpired = true
                    op.reply?.invoke(pending(op, op.stopReason!!)); op.reply = null
                    op.cancelReply?.invoke(pending(op, "${protocol.prefix}_action_cancel_pending")); op.cancelReply = null
                }
            }, cleanupGraceMs, TimeUnit.MILLISECONDS)
        }
        op.task.stop(reason)
    }

    private fun complete(op: Operation, result: JSONObject) = synchronized(lock) {
        if (active !== op) return@synchronized
        if (result.opt("ok") !is Boolean || result.opt("dispatched") !is Boolean || result.opt("ambiguous") !is Boolean ||
            result.opt("ok") == false && !nonempty(result.opt("error")) || result.opt("ok") == true && result.opt("ambiguous") != false) {
            // A malformed task completion cannot reopen device admission.
            stop(op, "invalid_${protocol.prefix}_execution_receipt"); return@synchronized
        }
        if (op.stopReason != null) result.put("ok", false).put("error", op.stopReason)
        result.put("actionId", op.actionId).put("runtimeEpoch", runtimeEpoch).put("settled", true)
            .put("execution", identity(op).put("settled", true))
        try { settledEvent(JSONObject(result.toString())) }
        catch (error: Throwable) { result.put("evidenceError", error.javaClass.name) }
        op.timeout?.cancel(false); op.cleanup?.cancel(false)
        lastResult = JSONObject(result.toString()); active = null
        op.reply?.invoke(result); op.reply = null
        op.cancelReply?.invoke(cancelReceipt(result)); op.cancelReply = null
    }

    private fun identity(op: Operation) = JSONObject().put("schemaVersion", protocol.schema).put("actionId", op.actionId).put("runtimeEpoch", runtimeEpoch)
    private fun pending(op: Operation, error: String) = identity(op).put("ok", false).put("error", error)
        .put("dispatched", JSONObject.NULL).put("ambiguous", true).put("settled", false)
    private fun cancelReceipt(result: JSONObject) = JSONObject().put("ok", true)
        .put("actionId", result.getString("actionId")).put("runtimeEpoch", runtimeEpoch).put("executionResult", JSONObject(result.toString()))
    private fun validIdentity(body: JSONObject) = body.keys().asSequence().toSet() == setOf("actionId", "runtimeEpoch") &&
        nonempty(body.opt("actionId")) && nonempty(body.opt("runtimeEpoch"))
    private fun nonempty(value: Any?) = value is String && value.isNotBlank()
    private fun integerMs(value: Any?) = (value is Int || value is Long) && (value as Number).toLong() in 1..2_147_483_647L
    private fun failure(error: String) = JSONObject().put("ok", false).put("error", error)
        .put("message", "${protocol.prefix} execution rejected: $error").put("dispatched", false).put("ambiguous", false)

    private class Operation(val kind: String, val actionId: String, val task: ManagedExecutionTask, var reply: ((JSONObject) -> Unit)?) {
        var stopReason: String? = null
        var timeout: ScheduledFuture<*>? = null
        var cleanup: ScheduledFuture<*>? = null
        var cleanupExpired = false
        var cancelReply: ((JSONObject) -> Unit)? = null
    }

}
