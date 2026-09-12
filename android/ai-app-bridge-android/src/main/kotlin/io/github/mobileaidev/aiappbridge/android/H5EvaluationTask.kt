package io.github.mobileaidev.aiappbridge.android

import org.json.JSONObject

internal class H5EvaluationFailure(val code: String, private val details: JSONObject = JSONObject()) : RuntimeException(code) {
    fun response(): JSONObject = h5Failure(code).apply {
        details.keys().forEach { key -> put(key, details.get(key)) }
    }
}
internal fun h5Failure(code: String) = JSONObject().put("ok", false).put("error", code)
    .put("message", "WebView execution rejected: $code").put("dispatched", false).put("ambiguous", false)

internal fun interface H5Evaluation {
    fun start(complete: (JSONObject) -> Unit)
}

// WebView submission has no cancellation acknowledgement. Before admission we
// can remove the queued task; after admission only its original callback and
// the returning Java invocation can prove that this evaluation ended.
internal class H5EvaluationTask(
    private val post: (Runnable) -> Boolean,
    private val remove: (Runnable) -> Unit,
    private val prepare: (() -> String?) -> H5Evaluation,
) : ManagedExecutionTask {
    private val lock = Any()
    private var callback: ((JSONObject) -> Unit)? = null
    private var result: JSONObject? = null
    private var dispatched = false
    private var delivered = false
    private var stopReason: String? = null

    private val task = Runnable {
        if (synchronized(lock) { result != null }) return@Runnable
        val evaluation = try { prepare { synchronized(lock) { stopReason } } }
        catch (error: H5EvaluationFailure) { reject(error.response()); return@Runnable }
        catch (_: Throwable) { reject("h5_preparation_failed"); return@Runnable }
        val admitted = synchronized(lock) {
            if (result != null) false else { dispatched = true; true }
        }
        if (!admitted) return@Runnable
        H5EvaluationInvocation { value ->
            synchronized(lock) { if (result == null) result = value }
            deliver()
        }.run(evaluation)
    }

    override fun start(complete: (JSONObject) -> Unit) {
        synchronized(lock) { callback = complete }
        if (synchronized(lock) { result != null }) { deliver(); return }
        if (!post(task)) reject("main_thread_unavailable")
    }

    override fun stop(reason: String) {
        synchronized(lock) {
            if (stopReason == null) stopReason = reason
            if (!dispatched && result == null) result = h5Failure(reason)
        }
        remove(task)
        deliver()
    }

    private fun reject(code: String) = reject(h5Failure(code))

    private fun reject(value: JSONObject) {
        synchronized(lock) { if (!dispatched && result == null) result = value }
        deliver()
    }

    private fun deliver() {
        val completion = synchronized(lock) {
            if (delivered || result == null || callback == null) return
            delivered = true
            callback!! to result!!
        }
        completion.first(completion.second)
    }
}
