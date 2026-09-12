package io.github.mobileaidev.aiappbridge.android

import org.json.JSONObject

// Every renderer turn, including a mutation submitted from a probe callback,
// must retain occupancy until both its callback and Java invocation finish.
internal class H5EvaluationInvocation(private val complete: (JSONObject) -> Unit) {
    private val lock = Any()
    private var result: JSONObject? = null
    private var returned = false
    private var error: String? = null
    private var delivered = false

    fun run(evaluation: H5Evaluation) {
        try {
            evaluation.start { value ->
                synchronized(lock) { if (result == null) result = JSONObject(value.toString()) }
                settle()
            }
        } catch (failure: Throwable) {
            // An adapter can throw after submitting work. Its original callback
            // is still required; the exception alone cannot release ownership.
            synchronized(lock) { error = failure.javaClass.name }
        } finally {
            synchronized(lock) { returned = true }
            settle()
        }
    }

    private fun settle() {
        val value = synchronized(lock) {
            if (delivered || !returned || result == null) return
            delivered = true
            result!!.apply {
                if (error != null) put("ok", false).put("error", "h5_submission_failed")
                    .put("dispatched", true).put("ambiguous", true).put("cause", error)
            }
        }
        complete(value)
    }
}
