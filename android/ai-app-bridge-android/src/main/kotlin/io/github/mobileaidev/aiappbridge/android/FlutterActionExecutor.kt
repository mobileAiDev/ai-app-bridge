package io.github.mobileaidev.aiappbridge.android

import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

// Native admission is independent of both the Android main thread and Dart.
// Dart obtains permission before each new mutation (a pointer sequence or an
// editor/scroll write). Revocation prevents another mutation, and an admitted
// sequence retains ownership until its original completion confirms settlement.
internal class FlutterActionExecutor(
    private val handler: () -> AiAppBridge.FlutterActionHandler?,
    private val runtimeEpoch: () -> String?,
    private val cleanupGraceMs: Long = 1500,
    private val now: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    private val lock = Any()
    private val timers = Executors.newSingleThreadScheduledExecutor { task ->
        Thread(task, "aab-flutter-lifetime").apply { isDaemon = true }
    }
    private var active: Operation? = null
    private var lastResult: JSONObject? = null

    fun isBusy(): Boolean = synchronized(lock) { active != null }
    fun status(): JSONObject? = synchronized(lock) {
        active?.let { op -> identity(op).put("stopReason", op.stopReason ?: JSONObject.NULL)
            .put("permissionIssued", op.permissionIssued).put("settled", false) }
    }

    fun submit(body: JSONObject, reply: (JSONObject) -> Unit) {
        val execution = body.optJSONObject("execution")
        if (execution == null || execution.keys().asSequence().toSet() != setOf("schemaVersion", "actionId", "runtimeEpoch", "timeoutMs") ||
            execution.opt("schemaVersion") != SCHEMA || !nonempty(execution.opt("actionId")) ||
            !nonempty(execution.opt("runtimeEpoch")) || !integerMs(execution.opt("timeoutMs")) ||
            body.opt("actionId") != execution.opt("actionId")) {
            reply(failure("invalid_flutter_execution")); return
        }
        val channel = handler()
        if (channel == null) { reply(failure("flutter_action_handler_absent")); return }
        if (runtimeEpoch() != execution.getString("runtimeEpoch")) {
            reply(failure("flutter_runtime_changed")); return
        }
        val op = Operation(execution.getString("actionId"), execution.getString("runtimeEpoch"),
            now() + execution.getLong("timeoutMs"), channel, reply)
        synchronized(lock) {
            if (active != null) { reply(failure("flutter_action_busy")); return }
            if (lastResult?.optString("actionId") == op.actionId && lastResult?.optString("runtimeEpoch") == op.epoch) {
                reply(failure("flutter_action_id_reused")); return
            }
            active = op
            op.timeout = timers.schedule({ stop(op, "flutter_action_timeout") }, execution.getLong("timeoutMs"), TimeUnit.MILLISECONDS)
        }
        try {
            channel.handle("executeAction", body.toString()) { value -> receive(op, value) }
        } catch (_: Throwable) {
            // The channel may have accepted delivery before throwing. Permission
            // revocation is authoritative; never guess that Dart already stopped.
            stop(op, "flutter_channel_failed")
        }
    }

    fun check(body: JSONObject): JSONObject {
        if (!validIdentity(body)) return failure("invalid_flutter_execution_identity")
        synchronized(lock) {
            val op = active
            if (op == null || !matches(op, body)) return failure("flutter_action_not_active")
            if (runtimeEpoch() != op.epoch) return failure("flutter_runtime_changed")
            if (op.stopReason != null || now() >= op.deadline) return failure(op.stopReason ?: "flutter_action_timeout")
            op.permissionIssued = true
            return identity(op).put("ok", true).put("remainingMs", (op.deadline - now()).coerceAtLeast(0))
        }
    }

    fun cancel(body: JSONObject, reply: (JSONObject) -> Unit) {
        if (!validIdentity(body)) { reply(failure("invalid_flutter_execution_identity")); return }
        val op = synchronized(lock) {
            lastResult?.takeIf { it.opt("actionId") == body.opt("actionId") && it.opt("runtimeEpoch") == body.opt("runtimeEpoch") }
                ?.let { reply(cancelReceipt(it)); return }
            val current = active
            if (current == null || !matches(current, body)) { reply(failure("flutter_action_not_active")); return }
            if (current.cancelReply != null || current.cleanupExpired) { reply(pending(current, "flutter_action_cancel_pending")); return }
            current.cancelReply = reply
            current
        }
        stop(op, "flutter_action_cancelled")
    }

    private fun stop(op: Operation, reason: String) {
        val first: Boolean
        synchronized(lock) {
            if (active !== op) return
            first = op.stopReason == null
            if (first) op.stopReason = reason
            if (!op.permissionIssued) {
                finish(op, identity(op).put("ok", false).put("error", op.stopReason)
                    .put("dispatched", false).put("ambiguous", false).put("settled", true))
            } else if (op.cleanup == null) {
                op.cleanup = timers.schedule({
                    synchronized(lock) {
                        if (active !== op) return@schedule
                        // Keep admission closed until a valid Dart completion.
                        op.cleanupExpired = true
                        op.reply?.invoke(pending(op, op.stopReason!!)); op.reply = null
                        op.cancelReply?.invoke(pending(op, "flutter_action_cancel_pending")); op.cancelReply = null
                    }
                }, cleanupGraceMs, TimeUnit.MILLISECONDS)
            }
        }
        if (first) try {
            op.channel.handle("cancelAction", identity(op).put("reason", op.stopReason).toString()) { }
        } catch (_: Throwable) { /* No acknowledgement; admission remains closed if permission was issued. */ }
    }

    private fun receive(op: Operation, value: String) {
        val result = try { JSONObject(value) } catch (_: org.json.JSONException) { null }
        val execution = result?.optJSONObject("execution")
        if (result == null || execution == null || execution.keys().asSequence().toSet() != setOf("schemaVersion", "actionId", "runtimeEpoch", "settled") || execution.opt("schemaVersion") != SCHEMA ||
            execution.opt("actionId") != op.actionId || execution.opt("runtimeEpoch") != op.epoch ||
            execution.opt("settled") != true || result.opt("ok") !is Boolean ||
            result.opt("dispatched") !is Boolean || result.opt("ambiguous") !is Boolean ||
            result.opt("ok") == false && !nonempty(result.opt("error"))) {
            stop(op, "invalid_flutter_execution_receipt"); return
        }
        synchronized(lock) {
            if (active !== op) return
            if (op.stopReason != null) result.put("ok", false).put("error", op.stopReason)
            finish(op, result)
        }
    }

    // lock is held; delivery callbacks enqueue I/O and never call App code.
    private fun finish(op: Operation, result: JSONObject) {
        if (active !== op) return
        result.put("actionId", op.actionId).put("runtimeEpoch", op.epoch).put("settled", true)
            .put("execution", identity(op).put("settled", true))
        op.timeout?.cancel(false); op.cleanup?.cancel(false)
        active = null; lastResult = JSONObject(result.toString())
        op.reply?.invoke(result); op.reply = null
        op.cancelReply?.invoke(cancelReceipt(result)); op.cancelReply = null
    }

    private fun identity(op: Operation) = JSONObject().put("schemaVersion", SCHEMA).put("actionId", op.actionId).put("runtimeEpoch", op.epoch)
    private fun pending(op: Operation, error: String) = identity(op).put("ok", false).put("error", error)
        .put("dispatched", JSONObject.NULL).put("ambiguous", true).put("settled", false)
    private fun cancelReceipt(result: JSONObject) = JSONObject().put("ok", true)
        .put("actionId", result.getString("actionId")).put("runtimeEpoch", result.getString("runtimeEpoch"))
        .put("executionResult", JSONObject(result.toString()))
    private fun matches(op: Operation, body: JSONObject) = body.opt("actionId") == op.actionId && body.opt("runtimeEpoch") == op.epoch
    private fun validIdentity(body: JSONObject) = body.keys().asSequence().toSet() == setOf("actionId", "runtimeEpoch") && nonempty(body.opt("actionId")) && nonempty(body.opt("runtimeEpoch"))
    private fun nonempty(value: Any?) = value is String && value.isNotBlank()
    private fun integerMs(value: Any?) = (value is Int || value is Long) && (value as Number).toLong() in 1..2_147_483_647L
    private fun failure(error: String) = JSONObject().put("ok", false).put("error", error).put("dispatched", false).put("ambiguous", false)

    private class Operation(val actionId: String, val epoch: String, val deadline: Long,
        val channel: AiAppBridge.FlutterActionHandler, var reply: ((JSONObject) -> Unit)?) {
        var stopReason: String? = null
        var permissionIssued = false
        var timeout: ScheduledFuture<*>? = null
        var cleanup: ScheduledFuture<*>? = null
        var cleanupExpired = false
        var cancelReply: ((JSONObject) -> Unit)? = null
    }

    companion object { const val SCHEMA = "aab.flutter-execution/v1" }
}
